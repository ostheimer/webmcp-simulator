import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { SandboxWrapperService } from './sandboxWrapperService.ts'
import { WrapperServiceError } from './wrapperErrors.ts'
import {
  WRAPPER_ACTION_TIMEOUT_MS,
  WRAPPER_ANALYSIS_TIMEOUT_MS,
  WRAPPER_CLOSE_CLEANUP_TIMEOUT_MS,
  WRAPPER_CLOSE_TIMEOUT_MS,
  WRAPPER_MAX_REQUEST_BODY_BYTES,
  WRAPPER_MAX_RATE_IDENTITIES_PER_FUNCTION,
  WRAPPER_MAX_RESPONSE_BYTES,
} from './wrapperLimits.ts'

const ANALYSIS_RATE_WINDOW_MS = 10 * 60 * 1000
const MAX_ANALYSES_PER_WINDOW = 4
const ACTION_RATE_WINDOW_MS = 60 * 1000
const MAX_ACTIONS_PER_WINDOW = 30
const CLOSE_RATE_WINDOW_MS = 60 * 1000
const MAX_CLOSES_PER_WINDOW = 30
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/

interface RateEntry {
  count: number
  resetAt: number
}

export class BoundedRateStore {
  private readonly entries = new Map<string, RateEntry>()
  private readonly capacity: number
  private readonly now: () => number

  constructor(
    capacity = WRAPPER_MAX_RATE_IDENTITIES_PER_FUNCTION,
    now: () => number = Date.now,
  ) {
    this.capacity = capacity
    this.now = now
  }

  consume(
    key: string,
    max: number,
    windowMs: number,
  ): 'allowed' | 'limited' | 'capacity' {
    const now = this.now()
    for (const [identity, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(identity)
    }
    const previous = this.entries.get(key)
    if (!previous && this.entries.size >= this.capacity) return 'capacity'
    const entry = previous ?? { count: 0, resetAt: now + windowMs }
    if (entry.count >= max) return 'limited'
    entry.count += 1
    this.entries.set(key, entry)
    return 'allowed'
  }

  get size(): number {
    return this.entries.size
  }
}

const activeAnalyses = new Set<string>()
const analysisRates = new BoundedRateStore()
const actionRates = new BoundedRateStore()
const closeRates = new BoundedRateStore()
const service = new SandboxWrapperService()

export interface ProductionWrapperBackend {
  analyze(url: string, signal?: AbortSignal): Promise<unknown>
  execute(
    sessionId: string,
    sessionToken: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    capabilityId?: string,
  ): Promise<unknown>
  closeSession(sessionId: string, sessionToken: string, signal?: AbortSignal): Promise<boolean>
}

export interface ProductionRequestOptions {
  /** Test-only override; production uses the fixed absolute analysis deadline. */
  analysisTimeoutMs?: number
  /** Test-only override; production uses the fixed absolute action deadline. */
  actionTimeoutMs?: number
  /** Test-only override; production uses the fixed absolute close deadline. */
  closeTimeoutMs?: number
  /** Test-only override for the post-deadline provider-cleanup settlement reserve. */
  closeCleanupTimeoutMs?: number
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly sessionInvalidated: boolean | undefined
  readonly headers: Record<string, string> | undefined

  constructor(
    message: string,
    status: number,
    code: string,
    options: { sessionInvalidated?: boolean, headers?: Record<string, string> } = {},
  ) {
    super(message)
    this.status = status
    this.code = code
    this.sessionInvalidated = options.sessionInvalidated
    this.headers = options.headers
  }
}

function assertRequestMethod(request: Request, expectedMethod: 'DELETE' | 'GET' | 'POST'): void {
  if (request.method === expectedMethod) return
  throw new HttpError(
    'This wrapper API endpoint does not support the requested method.',
    405,
    'method_not_allowed',
    { headers: { Allow: expectedMethod } },
  )
}

function trustedSourceIdentity(request: Request): string {
  const forwardedFor = request.headers.get('x-vercel-forwarded-for')?.trim() ?? ''
  if (!isIP(forwardedFor)) {
    throw new HttpError('A trusted Vercel client source is required.', 400, 'source_identity')
  }
  return createHash('sha256').update(`webmcp-wrapper-source:${forwardedFor}`).digest('base64url')
}

function jsonResponse(status: number, value: unknown, extraHeaders?: HeadersInit): Response {
  let body = JSON.stringify(value)
  if (Buffer.byteLength(body) > WRAPPER_MAX_RESPONSE_BYTES) {
    status = 507
    body = JSON.stringify({
      error: 'The isolated browser response exceeded the configured safety limit.',
      code: 'response_limit',
    })
  }
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  })
}

function assertRequestBoundary(request: Request): { clientId: string, sourceId: string } {
  if (request.headers.get('sec-fetch-site') === 'cross-site') {
    throw new HttpError('Cross-site wrapper API requests are not allowed.', 403, 'cross_site')
  }
  const origin = request.headers.get('origin')
  if (origin && origin !== new URL(request.url).origin) {
    throw new HttpError('Wrapper API origin does not match this application.', 403, 'origin_mismatch')
  }
  if (request.method === 'POST' || request.method === 'DELETE') {
    if (!request.headers.get('content-type')?.startsWith('application/json')) {
      throw new HttpError('Content-Type must be application/json.', 415, 'content_type')
    }
  }
  const clientId = request.headers.get('x-webmcp-client') ?? ''
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    throw new HttpError('A valid per-tab wrapper client identifier is required.', 400, 'client_id')
  }
  return { clientId, sourceId: trustedSourceIdentity(request) }
}

function requestAbortError(): DOMException {
  return new DOMException('The wrapper request was cancelled.', 'AbortError')
}

async function raceRequestOperation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    throw requestAbortError()
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const onAbort = () => {
      if (settled) return
      settled = true
      void promise.catch(() => undefined)
      reject(requestAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function waitForBoundedSettlement(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settled = promise.then(() => undefined, () => undefined)
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, timeoutMs))
    timer.unref?.()
  })
  try {
    await Promise.race([settled, timedOut])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readJson(request: Request, signal: AbortSignal = request.signal): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') ?? 0) > WRAPPER_MAX_REQUEST_BODY_BYTES) {
    throw new HttpError('Request body is too large.', 413, 'body_limit')
  }
  if (!request.body) return {}
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await raceRequestOperation(reader.read(), signal)
      if (done) break
      size += value.byteLength
      if (size > WRAPPER_MAX_REQUEST_BODY_BYTES) {
        await reader.cancel()
        throw new HttpError('Request body is too large.', 413, 'body_limit')
      }
      chunks.push(value)
    }
  } catch (error) {
    if (signal.aborted) void reader.cancel().catch(() => undefined)
    throw error
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpError('Expected valid JSON.', 400, 'invalid_json')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError('Expected a JSON object.', 400, 'invalid_json')
  }
  return parsed as Record<string, unknown>
}

function consumeRateLimit(
  store: BoundedRateStore,
  key: string,
  max: number,
  windowMs: number,
): void {
  const decision = store.consume(key, max, windowMs)
  if (decision === 'limited') {
    throw new HttpError('The wrapper rate limit was reached. Try again after the current window.', 429, 'rate_limit')
  }
  if (decision === 'capacity') {
    throw new HttpError('The wrapper rate-limit capacity is temporarily unavailable.', 429, 'rate_limit')
  }
}

function publicError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof WrapperServiceError) {
    return new HttpError(error.message, error.status, error.code, {
      sessionInvalidated: error.sessionInvalidated,
    })
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new HttpError('The isolated browser operation was cancelled.', 499, 'cancelled')
  }
  console.error('[webmcp-wrapper] unexpected internal failure', {
    causeType: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name)
      ? error.name
      : 'unknown',
  })
  return new HttpError('The isolated browser operation failed.', 500, 'internal_error')
}

async function handle(
  operation: () => Promise<unknown>,
  assertSuccessResponseAllowed?: () => void,
): Promise<Response> {
  try {
    const value = await operation()
    assertSuccessResponseAllowed?.()
    let response: Response
    try {
      response = jsonResponse(200, value)
    } catch (error) {
      assertSuccessResponseAllowed?.()
      throw error
    }
    assertSuccessResponseAllowed?.()
    return response
  } catch (error) {
    const safe = publicError(error)
    return jsonResponse(safe.status, {
      error: safe.message,
      code: safe.code,
      ...(typeof safe.sessionInvalidated === 'boolean'
        ? { sessionInvalidated: safe.sessionInvalidated }
        : {}),
    }, safe.headers)
  }
}

export function handleAnalyzeRequest(
  request: Request,
  backend: ProductionWrapperBackend = service,
  options: ProductionRequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.analysisTimeoutMs ?? WRAPPER_ANALYSIS_TIMEOUT_MS
  const deadlineAtMs = Date.now() + Math.max(0, timeoutMs)
  let deadlineExpired = false
  const operationController = new AbortController()
  const onRequestAbort = () => operationController.abort()
  request.signal.addEventListener('abort', onRequestAbort, { once: true })
  if (request.signal.aborted) operationController.abort()
  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true
    operationController.abort()
  }, Math.max(0, timeoutMs))
  deadlineTimer.unref?.()
  const deadlineReached = () => deadlineExpired || Date.now() >= deadlineAtMs
  const analysisTimeoutError = () => new HttpError(
    'The isolated browser analysis exceeded its fixed time limit.',
    504,
    'analysis_timeout',
  )
  let acceptedSession: { sessionId: string, sessionToken: string } | undefined
  let cleanupStarted = false
  const cleanupAnalysisSession = (sessionId: string, sessionToken: string) => {
    if (cleanupStarted) return
    cleanupStarted = true
    void backend.closeSession(sessionId, sessionToken).catch(() => undefined)
  }
  const cleanupLateAnalysis = (value: unknown) => {
    if (!value || typeof value !== 'object') return
    const result = value as { sessionId?: unknown, sessionToken?: unknown }
    if (typeof result.sessionId !== 'string' || typeof result.sessionToken !== 'string') return
    cleanupAnalysisSession(result.sessionId, result.sessionToken)
  }
  const assertAnalysisResponseAllowed = () => {
    if (!deadlineReached() && !request.signal.aborted) return
    operationController.abort()
    if (acceptedSession) {
      cleanupAnalysisSession(acceptedSession.sessionId, acceptedSession.sessionToken)
    }
    if (deadlineReached()) throw analysisTimeoutError()
    throw requestAbortError()
  }
  return handle(async () => {
    try {
      assertRequestMethod(request, 'POST')
      const { sourceId } = assertRequestBoundary(request)
      consumeRateLimit(analysisRates, sourceId, MAX_ANALYSES_PER_WINDOW, ANALYSIS_RATE_WINDOW_MS)
      if (activeAnalyses.has(sourceId)) {
        throw new HttpError('Only one website analysis may run for this network source.', 409, 'analysis_in_progress')
      }
      activeAnalyses.add(sourceId)
      try {
        const body = await readJson(request, operationController.signal)
        if (typeof body.url !== 'string') throw new HttpError('url must be a string.', 400, 'invalid_url')
        if (deadlineReached()) throw analysisTimeoutError()
        const analysisPromise = backend.analyze(body.url, operationController.signal)
        let result: unknown
        try {
          result = await raceRequestOperation(analysisPromise, operationController.signal)
        } catch (error) {
          if (operationController.signal.aborted) {
            void analysisPromise.then(cleanupLateAnalysis).catch(() => undefined)
          }
          throw error
        }
        if (deadlineReached()) {
          cleanupLateAnalysis(result)
          throw analysisTimeoutError()
        }
        if (result && typeof result === 'object') {
          const session = result as { sessionId?: unknown, sessionToken?: unknown }
          if (typeof session.sessionId === 'string' && typeof session.sessionToken === 'string') {
            acceptedSession = { sessionId: session.sessionId, sessionToken: session.sessionToken }
          }
        }
        return result
      } finally {
        activeAnalyses.delete(sourceId)
      }
    } catch (error) {
      if (deadlineReached()) throw analysisTimeoutError()
      if (request.signal.aborted) throw requestAbortError()
      throw error
    }
  }, assertAnalysisResponseAllowed).finally(() => {
    clearTimeout(deadlineTimer)
    request.signal.removeEventListener('abort', onRequestAbort)
  })
}

export function handleActionRequest(
  request: Request,
  backend: ProductionWrapperBackend = service,
  options: ProductionRequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.actionTimeoutMs ?? WRAPPER_ACTION_TIMEOUT_MS
  const deadlineAtMs = Date.now() + Math.max(0, timeoutMs)
  let deadlineExpired = false
  let backendStarted = false
  let acceptedSession: { sessionId: string, sessionToken: string } | undefined
  const operationController = new AbortController()
  const onRequestAbort = () => operationController.abort()
  request.signal.addEventListener('abort', onRequestAbort, { once: true })
  if (request.signal.aborted) operationController.abort()
  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true
    operationController.abort()
  }, Math.max(0, timeoutMs))
  deadlineTimer.unref?.()
  const deadlineReached = () => deadlineExpired || Date.now() >= deadlineAtMs
  const actionTimeoutError = () => new HttpError(
    'The isolated browser action exceeded its fixed time limit.',
    504,
    'action_timeout',
    { sessionInvalidated: backendStarted },
  )
  const actionCancelledError = () => new HttpError(
    'The isolated browser operation was cancelled.',
    499,
    'cancelled',
    { sessionInvalidated: backendStarted },
  )
  let cleanupStarted = false
  const cleanupActionSession = (sessionId: string, sessionToken: string) => {
    if (cleanupStarted) return
    cleanupStarted = true
    void backend.closeSession(sessionId, sessionToken).catch(() => undefined)
  }
  const cleanupLateAction = (value: unknown) => {
    if (acceptedSession) {
      cleanupActionSession(acceptedSession.sessionId, acceptedSession.sessionToken)
      return
    }
    if (!value || typeof value !== 'object') return
    const analysis = (value as { analysis?: unknown }).analysis
    if (!analysis || typeof analysis !== 'object') return
    const result = analysis as { sessionId?: unknown, sessionToken?: unknown }
    if (typeof result.sessionId !== 'string' || typeof result.sessionToken !== 'string') return
    cleanupActionSession(result.sessionId, result.sessionToken)
  }
  const assertActionResponseAllowed = () => {
    if (!deadlineReached() && !request.signal.aborted) return
    operationController.abort()
    if (acceptedSession) cleanupActionSession(acceptedSession.sessionId, acceptedSession.sessionToken)
    if (deadlineReached()) throw actionTimeoutError()
    throw actionCancelledError()
  }
  return handle(async () => {
    try {
      assertRequestMethod(request, 'POST')
      const { sourceId } = assertRequestBoundary(request)
      consumeRateLimit(actionRates, sourceId, MAX_ACTIONS_PER_WINDOW, ACTION_RATE_WINDOW_MS)
      const body = await readJson(request, operationController.signal)
      if (
        typeof body.sessionId !== 'string'
        || typeof body.sessionToken !== 'string'
        || typeof body.toolName !== 'string'
        || typeof body.capabilityId !== 'string'
        || !body.input
        || typeof body.input !== 'object'
        || Array.isArray(body.input)
      ) throw new HttpError('sessionId, sessionToken, capabilityId, toolName, and input are required.', 400, 'invalid_action')
      if (deadlineReached()) throw actionTimeoutError()
      acceptedSession = { sessionId: body.sessionId, sessionToken: body.sessionToken }
      backendStarted = true
      const actionPromise = backend.execute(
        body.sessionId,
        body.sessionToken,
        body.toolName,
        body.input as Record<string, unknown>,
        operationController.signal,
        body.capabilityId,
      )
      let result: unknown
      try {
        result = await raceRequestOperation(actionPromise, operationController.signal)
      } catch (error) {
        if (operationController.signal.aborted) {
          if (acceptedSession) cleanupActionSession(acceptedSession.sessionId, acceptedSession.sessionToken)
          void actionPromise.then(cleanupLateAction).catch(() => undefined)
        }
        throw error
      }
      if (deadlineReached()) {
        cleanupActionSession(body.sessionId, body.sessionToken)
        throw actionTimeoutError()
      }
      return result
    } catch (error) {
      if (deadlineReached()) throw actionTimeoutError()
      if (request.signal.aborted) throw actionCancelledError()
      if (!backendStarted && error instanceof HttpError) {
        throw new HttpError(error.message, error.status, error.code, {
          sessionInvalidated: false,
          headers: error.headers,
        })
      }
      throw error
    }
  }, assertActionResponseAllowed).finally(() => {
    clearTimeout(deadlineTimer)
    request.signal.removeEventListener('abort', onRequestAbort)
  })
}

export function handleCloseRequest(
  request: Request,
  backend: ProductionWrapperBackend = service,
  options: ProductionRequestOptions = {},
): Promise<Response> {
  const timeoutMs = options.closeTimeoutMs ?? WRAPPER_CLOSE_TIMEOUT_MS
  const cleanupTimeoutMs = options.closeCleanupTimeoutMs ?? WRAPPER_CLOSE_CLEANUP_TIMEOUT_MS
  const deadlineAtMs = Date.now() + Math.max(0, timeoutMs)
  let deadlineExpired = false
  const operationController = new AbortController()
  const onRequestAbort = () => operationController.abort()
  request.signal.addEventListener('abort', onRequestAbort, { once: true })
  if (request.signal.aborted) operationController.abort()
  const deadlineTimer = setTimeout(() => {
    deadlineExpired = true
    operationController.abort()
  }, Math.max(0, timeoutMs))
  deadlineTimer.unref?.()
  const deadlineReached = () => deadlineExpired || Date.now() >= deadlineAtMs
  const closeTimeoutError = () => new HttpError(
    'The isolated browser close operation exceeded its fixed time limit.',
    504,
    'close_timeout',
  )
  const closeCancelledError = () => new HttpError(
    'The isolated browser operation was cancelled.',
    499,
    'cancelled',
  )
  const assertCloseResponseAllowed = () => {
    if (!deadlineReached() && !request.signal.aborted) return
    operationController.abort()
    if (deadlineReached()) throw closeTimeoutError()
    throw closeCancelledError()
  }
  let closePromise: Promise<boolean> | undefined
  return handle(async () => {
    try {
      assertRequestMethod(request, 'DELETE')
      const { sourceId } = assertRequestBoundary(request)
      // A close attempt consumes its trusted-source budget before any untrusted
      // streamed body is read, so random locator/token bodies cannot cheaply
      // occupy the handler or drive provider reconnects without a bounded quota.
      consumeRateLimit(closeRates, sourceId, MAX_CLOSES_PER_WINDOW, CLOSE_RATE_WINDOW_MS)
      const body = await readJson(request, operationController.signal)
      if (typeof body.sessionId !== 'string' || typeof body.sessionToken !== 'string') {
        throw new HttpError('sessionId and sessionToken are required.', 400, 'invalid_session')
      }
      if (deadlineReached()) throw closeTimeoutError()
      closePromise = backend.closeSession(
        body.sessionId,
        body.sessionToken,
        operationController.signal,
      )
      await raceRequestOperation(closePromise, operationController.signal)
      if (deadlineReached()) throw closeTimeoutError()
      // Closing an already absent/expired session is intentionally idempotent.
      // Do not expose whether a random valid-shaped locator/token pair existed.
      return { closed: true }
    } catch (error) {
      if (operationController.signal.aborted && closePromise) {
        // Keep the Function alive for the bounded, request-independent provider
        // deletion retry. Returning immediately lets Vercel freeze the promise
        // before the already-closed worker sandbox releases its capacity.
        await waitForBoundedSettlement(closePromise, cleanupTimeoutMs)
      }
      if (deadlineReached()) throw closeTimeoutError()
      if (request.signal.aborted) throw closeCancelledError()
      throw error
    }
  }, assertCloseResponseAllowed).finally(() => {
    clearTimeout(deadlineTimer)
    request.signal.removeEventListener('abort', onRequestAbort)
  })
}

export function handleHealthRequest(
  request: Request,
  configuration: { snapshotId?: string, image?: string } = {
    snapshotId: process.env.WEBMCP_SANDBOX_SNAPSHOT_ID,
    image: process.env.WEBMCP_SANDBOX_IMAGE,
  },
): Response {
  try {
    assertRequestMethod(request, 'GET')
    const ready = Boolean(configuration.snapshotId?.trim() || configuration.image?.trim())
    return jsonResponse(200, {
      alive: true,
      ready,
      mode: 'vercel-sandbox',
      configuration: ready ? 'configured' : 'missing-browser-source',
      persistence: false,
      sessionTtlSeconds: 300,
      maxPages: 10,
    })
  } catch (error) {
    const safe = publicError(error)
    return jsonResponse(safe.status, {
      error: safe.message,
      code: safe.code,
    }, safe.headers)
  }
}
