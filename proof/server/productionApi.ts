import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { SandboxWrapperService } from './sandboxWrapperService.ts'
import { WrapperServiceError } from './wrapperErrors.ts'
import {
  WRAPPER_MAX_REQUEST_BODY_BYTES,
  WRAPPER_MAX_RESPONSE_BYTES,
} from './wrapperLimits.ts'

const ANALYSIS_RATE_WINDOW_MS = 10 * 60 * 1000
const MAX_ANALYSES_PER_WINDOW = 4
const ACTION_RATE_WINDOW_MS = 60 * 1000
const MAX_ACTIONS_PER_WINDOW = 30
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,80}$/

interface RateEntry {
  count: number
  resetAt: number
}

const activeAnalyses = new Set<string>()
const analysisRates = new Map<string, RateEntry>()
const actionRates = new Map<string, RateEntry>()
const service = new SandboxWrapperService()

export interface ProductionWrapperBackend {
  analyze(url: string, signal?: AbortSignal): Promise<unknown>
  execute(
    sessionId: string,
    sessionToken: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>
  closeSession(sessionId: string, sessionToken: string, signal?: AbortSignal): Promise<boolean>
}

class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(
    message: string,
    status: number,
    code: string,
  ) {
    super(message)
    this.status = status
    this.code = code
  }
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

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length') ?? 0) > WRAPPER_MAX_REQUEST_BODY_BYTES) {
    throw new HttpError('Request body is too large.', 413, 'body_limit')
  }
  if (!request.body) return {}
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > WRAPPER_MAX_REQUEST_BODY_BYTES) {
      await reader.cancel()
      throw new HttpError('Request body is too large.', 413, 'body_limit')
    }
    chunks.push(value)
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
  store: Map<string, RateEntry>,
  key: string,
  max: number,
  windowMs: number,
): void {
  const now = Date.now()
  const previous = store.get(key)
  const entry = !previous || previous.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : previous
  if (entry.count >= max) {
    throw new HttpError('The wrapper rate limit was reached. Try again after the current window.', 429, 'rate_limit')
  }
  entry.count += 1
  store.set(key, entry)
}

function publicError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof WrapperServiceError) {
    return new HttpError(error.message, error.status, error.code)
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

async function handle(operation: () => Promise<unknown>): Promise<Response> {
  try {
    return jsonResponse(200, await operation())
  } catch (error) {
    const safe = publicError(error)
    return jsonResponse(safe.status, { error: safe.message, code: safe.code })
  }
}

export function handleAnalyzeRequest(
  request: Request,
  backend: ProductionWrapperBackend = service,
): Promise<Response> {
  return handle(async () => {
    const { sourceId } = assertRequestBoundary(request)
    consumeRateLimit(analysisRates, sourceId, MAX_ANALYSES_PER_WINDOW, ANALYSIS_RATE_WINDOW_MS)
    if (activeAnalyses.has(sourceId)) {
      throw new HttpError('Only one website analysis may run for this network source.', 409, 'analysis_in_progress')
    }
    const body = await readJson(request)
    if (typeof body.url !== 'string') throw new HttpError('url must be a string.', 400, 'invalid_url')
    activeAnalyses.add(sourceId)
    try {
      return await backend.analyze(body.url, request.signal)
    } finally {
      activeAnalyses.delete(sourceId)
    }
  })
}

export function handleActionRequest(
  request: Request,
  backend: ProductionWrapperBackend = service,
): Promise<Response> {
  return handle(async () => {
    const { sourceId } = assertRequestBoundary(request)
    consumeRateLimit(actionRates, sourceId, MAX_ACTIONS_PER_WINDOW, ACTION_RATE_WINDOW_MS)
    const body = await readJson(request)
    if (
      typeof body.sessionId !== 'string'
      || typeof body.sessionToken !== 'string'
      || typeof body.toolName !== 'string'
      || !body.input
      || typeof body.input !== 'object'
      || Array.isArray(body.input)
    ) throw new HttpError('sessionId, sessionToken, toolName, and input are required.', 400, 'invalid_action')
    return backend.execute(
      body.sessionId,
      body.sessionToken,
      body.toolName,
      body.input as Record<string, unknown>,
      request.signal,
    )
  })
}

export function handleCloseRequest(
  request: Request,
  backend: ProductionWrapperBackend = service,
): Promise<Response> {
  return handle(async () => {
    assertRequestBoundary(request)
    const body = await readJson(request)
    if (typeof body.sessionId !== 'string' || typeof body.sessionToken !== 'string') {
      throw new HttpError('sessionId and sessionToken are required.', 400, 'invalid_session')
    }
    const closed = await backend.closeSession(body.sessionId, body.sessionToken, request.signal)
    if (!closed) throw new HttpError('The isolated browser session capability is invalid.', 401, 'invalid_capability')
    return { closed: true }
  })
}

export function handleHealthRequest(): Response {
  return jsonResponse(200, {
    ready: true,
    mode: 'vercel-sandbox',
    persistence: false,
    sessionTtlSeconds: 300,
    maxPages: 10,
  })
}
