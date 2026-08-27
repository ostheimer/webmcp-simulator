import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { WrapperProofService } from './wrapperService.ts'

const MAX_BODY_BYTES = 32 * 1024

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Request body is too large.')
    chunks.push(buffer)
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Expected a JSON object.')
  }
  return parsed as Record<string, unknown>
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
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
}

export function wrapperProofPlugin(): Plugin {
  const service = new WrapperProofService()
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
            sendJson(response, 200, await service.analyze(body.url))
            return
          }
          if (request.method === 'POST' && request.url === '/action') {
            const body = await readJson(request)
            if (
              typeof body.sessionId !== 'string'
              || typeof body.toolName !== 'string'
              || !body.input
              || typeof body.input !== 'object'
              || Array.isArray(body.input)
            ) {
              throw new Error('sessionId, toolName, and input are required.')
            }
            sendJson(response, 200, await service.execute(
              body.sessionId,
              body.toolName,
              body.input as Record<string, unknown>,
            ))
            return
          }
          if (request.method === 'DELETE' && request.url.startsWith('/session/')) {
            const sessionId = decodeURIComponent(request.url.slice('/session/'.length))
            await service.closeSession(sessionId)
            sendJson(response, 200, { closed: true })
            return
          }
          next()
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : 'Wrapper proof failed.',
          })
        }
      })
      server.httpServer?.once('close', () => void service.close())
    },
  }
}
