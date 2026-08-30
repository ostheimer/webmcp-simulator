import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { WrapperProofService } from './wrapperService.ts'
import {
  WRAPPER_ANALYSIS_TIMEOUT_MS,
  WRAPPER_MAX_REQUEST_BODY_BYTES,
} from './wrapperLimits.ts'
import { WrapperServiceError } from './wrapperErrors.ts'

export function localPublicError(
  error: unknown,
  actionRequest: boolean,
): { status: number, body: { error: string, code: string, sessionInvalidated?: boolean } } {
  if (error instanceof WrapperServiceError) {
    const sessionInvalidated = error.sessionInvalidated
      ?? (actionRequest ? true : undefined)
    return {
      status: error.status,
      body: {
        error: error.message,
        code: error.code,
        ...(typeof sessionInvalidated === 'boolean' ? { sessionInvalidated } : {}),
      },
    }
  }
  console.error('[webmcp-wrapper-local] unexpected internal failure', {
    causeType: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(error.name)
      ? error.name
      : 'unknown',
  })
  return {
    status: 500,
    body: {
      error: 'The isolated browser operation failed.',
      code: 'internal_error',
      ...(actionRequest ? { sessionInvalidated: true } : {}),
    },
  }
}

function localBoundaryError(
  message: string,
  status: number,
  actionRequest: boolean,
  code: 'body_limit' | 'invalid_action' = 'invalid_action',
): WrapperServiceError {
  return new WrapperServiceError(
    code,
    message,
    status,
    actionRequest ? { sessionInvalidated: false } : {},
  )
}

function localAbortError(): DOMException {
  return new DOMException('The local wrapper request was cancelled.', 'AbortError')
}

async function raceLocalSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    void promise.catch(() => undefined)
    throw localAbortError()
  }
  let rejectAbort!: (reason: DOMException) => void
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = () => rejectAbort(localAbortError())
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function readJson(
  request: IncomingMessage,
  actionRequest: boolean,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const declaredLength = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declaredLength) && declaredLength > WRAPPER_MAX_REQUEST_BODY_BYTES) {
    throw localBoundaryError('Request body is too large.', 413, actionRequest, 'body_limit')
  }
  const chunks: Buffer[] = []
  let size = 0
  const iterator = request[Symbol.asyncIterator]()
  while (true) {
    const next = await raceLocalSignal(iterator.next(), signal)
    if (next.done) break
    const chunk = next.value
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > WRAPPER_MAX_REQUEST_BODY_BYTES) {
      throw localBoundaryError('Request body is too large.', 413, actionRequest, 'body_limit')
    }
    chunks.push(buffer)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw localBoundaryError('Expected valid JSON.', 400, actionRequest)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw localBoundaryError('Expected a JSON object.', 400, actionRequest)
  }
  return parsed as Record<string, unknown>
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.destroyed || response.writableEnded) return
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json; charset=utf-8')
  response.setHeader('Cache-Control', 'no-store')
  response.end(JSON.stringify(body))
}

function assertLocalApiRequest(request: IncomingMessage, actionRequest: boolean): void {
  if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) {
    throw localBoundaryError('Content-Type must be application/json.', 415, actionRequest)
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw localBoundaryError('Cross-site wrapper API requests are not allowed.', 403, actionRequest)
  }
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin && host) {
    let originHost = ''
    try {
      originHost = new URL(origin).host
    } catch {
      throw localBoundaryError('Wrapper API origin does not match the local application.', 403, actionRequest)
    }
    if (originHost !== host) {
      throw localBoundaryError('Wrapper API origin does not match the local application.', 403, actionRequest)
    }
  }
  const clientId = request.headers['x-webmcp-client']
  if (request.method !== 'GET' && (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(clientId))) {
    throw localBoundaryError('A valid per-tab wrapper client identifier is required.', 400, actionRequest)
  }
}

export interface WrapperProofPluginOptions {
  /** Test-only override. Production-like local development uses the fixed shared limit. */
  analysisTimeoutMs?: number
  /** Test-only scheduling hook for the post-result/pre-response deadline boundary. */
  beforeAnalyzeResponse?: () => Promise<void>
}

export function wrapperProofPlugin(
  service = new WrapperProofService(),
  options: WrapperProofPluginOptions = {},
): Plugin {
  const activeAnalyses = new Set<string>()
  const analysisTimeoutMs = options.analysisTimeoutMs ?? WRAPPER_ANALYSIS_TIMEOUT_MS
  return {
    name: 'webmcp-wrapper-proof',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/wrapper', async (request, response, next) => {
        if (!request.url) {
          next()
          return
        }
        const actionRequest = request.method === 'POST' && request.url === '/action'
        try {
          assertLocalApiRequest(request, actionRequest)
          if (request.method === 'GET' && request.url === '/health') {
            sendJson(response, 200, {
              ready: true,
              mode: 'local-proof',
              persistence: false,
              deployment: false,
            })
            return
          }
          if (request.method === 'POST' && request.url === '/analyze') {
            const controller = new AbortController()
            let requestAborted = false
            let deadlineExpired = false
            const abort = () => {
              requestAborted = true
              controller.abort()
            }
            const abortOnClosedResponse = () => {
              if (!response.writableEnded) abort()
            }
            const deadline = setTimeout(() => {
              deadlineExpired = true
              controller.abort()
            }, analysisTimeoutMs)
            request.once('aborted', abort)
            response.once('close', abortOnClosedResponse)
            try {
              const body = await readJson(request, false, controller.signal)
              if (typeof body.url !== 'string') {
                throw localBoundaryError('url must be a string.', 400, false)
              }
              const clientId = request.headers['x-webmcp-client'] as string
              if (activeAnalyses.has(clientId)) {
                throw localBoundaryError('Only one website analysis may run per browser tab.', 409, false)
              }
              activeAnalyses.add(clientId)
              try {
                const analysis = await service.analyze(body.url, controller.signal)
                await options.beforeAnalyzeResponse?.()
                if (controller.signal.aborted) {
                  await service.closeSession(analysis.sessionId, analysis.sessionToken)
                  if (deadlineExpired && !requestAborted) {
                    throw new WrapperServiceError(
                      'analysis_timeout',
                      'The isolated website analysis exceeded its safety deadline.',
                      504,
                    )
                  }
                  return
                }
                sendJson(response, 200, analysis)
              } finally {
                activeAnalyses.delete(clientId)
              }
            } catch (error) {
              if (requestAborted) return
              if (deadlineExpired) {
                throw new WrapperServiceError(
                  'analysis_timeout',
                  'The isolated website analysis exceeded its safety deadline.',
                  504,
                )
              }
              throw error
            } finally {
              clearTimeout(deadline)
              request.off('aborted', abort)
              response.off('close', abortOnClosedResponse)
            }
            return
          }
          if (request.method === 'POST' && request.url === '/action') {
            const body = await readJson(request, true)
            if (
              typeof body.sessionId !== 'string'
              || typeof body.sessionToken !== 'string'
              || typeof body.toolName !== 'string'
              || typeof body.capabilityId !== 'string'
              || !body.input
              || typeof body.input !== 'object'
              || Array.isArray(body.input)
            ) {
              throw localBoundaryError(
                'sessionId, sessionToken, capabilityId, toolName, and input are required.',
                400,
                true,
              )
            }
            const controller = new AbortController()
            const abort = () => controller.abort()
            const abortOnClosedResponse = () => {
              if (!response.writableEnded) controller.abort()
            }
            request.once('aborted', abort)
            response.once('close', abortOnClosedResponse)
            try {
              const result = await service.execute(
                body.sessionId,
                body.sessionToken,
                body.toolName,
                body.input as Record<string, unknown>,
                controller.signal,
                body.capabilityId,
              )
              if (controller.signal.aborted) {
                await service.closeSession(body.sessionId, body.sessionToken)
                return
              }
              sendJson(response, 200, result)
            } finally {
              request.off('aborted', abort)
              response.off('close', abortOnClosedResponse)
            }
            return
          }
          if (request.method === 'DELETE' && request.url === '/session') {
            const body = await readJson(request, false)
            if (typeof body.sessionId !== 'string' || typeof body.sessionToken !== 'string') {
              throw localBoundaryError('sessionId and sessionToken are required.', 400, false)
            }
            const closed = await service.closeSession(body.sessionId, body.sessionToken)
            sendJson(response, closed ? 200 : 401, closed
              ? { closed: true }
              : { error: 'The isolated browser session capability is invalid.' })
            return
          }
          next()
        } catch (error) {
          const safe = localPublicError(error, actionRequest)
          sendJson(response, safe.status, safe.body)
        }
      })
      server.httpServer?.once('close', () => void service.close())
    },
  }
}
