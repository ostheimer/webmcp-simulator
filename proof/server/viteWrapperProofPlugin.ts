import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { WrapperProofService } from './wrapperService.ts'
import { WRAPPER_MAX_REQUEST_BODY_BYTES } from './wrapperLimits.ts'
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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > WRAPPER_MAX_REQUEST_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object.')
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

function assertLocalApiRequest(request: IncomingMessage): void {
  if (request.method === 'POST' && !request.headers['content-type']?.startsWith('application/json')) {
    throw new Error('Content-Type must be application/json.')
  }
  if (request.headers['sec-fetch-site'] === 'cross-site') {
    throw new Error('Cross-site wrapper API requests are not allowed.')
  }
  const origin = request.headers.origin
  const host = request.headers.host
  if (origin && host && new URL(origin).host !== host) {
    throw new Error('Wrapper API origin does not match the local application.')
  }
  const clientId = request.headers['x-webmcp-client']
  if (request.method !== 'GET' && (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(clientId))) {
    throw new Error('A valid per-tab wrapper client identifier is required.')
  }
}

export function wrapperProofPlugin(): Plugin {
  const service = new WrapperProofService()
  const activeAnalyses = new Set<string>()
  return {
    name: 'webmcp-wrapper-proof',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/wrapper', async (request, response, next) => {
        if (!request.url) {
          next()
          return
        }
        try {
          assertLocalApiRequest(request)
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
            const body = await readJson(request)
            if (typeof body.url !== 'string') throw new Error('url must be a string.')
            const clientId = request.headers['x-webmcp-client'] as string
            if (activeAnalyses.has(clientId)) throw new Error('Only one website analysis may run per browser tab.')
            activeAnalyses.add(clientId)
            try {
              sendJson(response, 200, await service.analyze(body.url))
            } finally {
              activeAnalyses.delete(clientId)
            }
            return
          }
          if (request.method === 'POST' && request.url === '/action') {
            const body = await readJson(request)
            if (
              typeof body.sessionId !== 'string'
              || typeof body.sessionToken !== 'string'
              || typeof body.toolName !== 'string'
              || typeof body.capabilityId !== 'string'
              || !body.input
              || typeof body.input !== 'object'
              || Array.isArray(body.input)
            ) {
              throw new Error('sessionId, capabilityId, toolName, and input are required.')
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
            const body = await readJson(request)
            if (typeof body.sessionId !== 'string' || typeof body.sessionToken !== 'string') {
              throw new Error('sessionId and sessionToken are required.')
            }
            const closed = await service.closeSession(body.sessionId, body.sessionToken)
            sendJson(response, closed ? 200 : 401, closed
              ? { closed: true }
              : { error: 'The isolated browser session capability is invalid.' })
            return
          }
          next()
        } catch (error) {
          const safe = localPublicError(error, request.url === '/action')
          sendJson(response, safe.status, safe.body)
        }
      })
      server.httpServer?.once('close', () => void service.close())
    },
  }
}
