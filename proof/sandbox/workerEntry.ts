import { timingSafeEqual } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WrapperProofService } from '../server/wrapperService.ts'
import type { PublicTarget } from '../server/publicTarget.ts'
import { isPublicWrapperErrorCode, WrapperServiceError } from '../server/wrapperErrors.ts'
import {
  WRAPPER_MAX_REQUEST_BODY_BYTES,
  WRAPPER_MAX_RESPONSE_BYTES,
} from '../server/wrapperLimits.ts'

interface WorkerConfig {
  socketPath: string
  capabilityToken: string
  expiresAtMs: number
  target: PublicTarget
}

function matchesToken(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected)
  const providedBuffer = Buffer.from(provided)
  return expectedBuffer.length === providedBuffer.length
    && timingSafeEqual(expectedBuffer, providedBuffer)
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.byteLength
    if (size > WRAPPER_MAX_REQUEST_BODY_BYTES) {
      throw new WrapperServiceError('body_limit', 'Request body is too large.', 413)
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WrapperServiceError('invalid_action', 'Expected a JSON object.', 400)
  }
  return parsed as Record<string, unknown>
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.writableEnded || response.destroyed) return
  const body = JSON.stringify(value)
  if (Buffer.byteLength(body) > WRAPPER_MAX_RESPONSE_BYTES) {
    response.writeHead(507, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({
      error: 'The isolated response exceeded the safety limit.',
      code: 'response_limit',
    }))
    return
  }
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  response.end(body)
}

const configPath = process.argv[2]
if (!configPath) throw new Error('Worker config path is required.')
const config = JSON.parse(await readFile(configPath, 'utf8')) as WorkerConfig
process.umask(0o077)
await rm(config.socketPath, { force: true })

const service = new WrapperProofService({ resolveTarget: async () => config.target })
let internalSessionId = ''
let internalSessionToken = ''
let closing = false

async function closeWorker(): Promise<void> {
  if (closing) return
  closing = true
  await service.close()
  server.close()
  await rm(config.socketPath, { force: true }).catch(() => undefined)
}

const server = createServer(async (request, response) => {
  const abortController = new AbortController()
  const abort = () => abortController.abort()
  request.once('aborted', abort)
  response.once('close', abort)
  try {
    const token = request.headers['x-wrapper-capability']
    if (typeof token !== 'string' || !matchesToken(config.capabilityToken, token)) {
      sendJson(response, 401, {
        error: 'Invalid session capability.',
        code: 'invalid_capability',
        sessionInvalidated: false,
      })
      return
    }
    if (Date.now() >= config.expiresAtMs) {
      sendJson(response, 410, { error: 'The isolated browser session expired.', code: 'session_expired' })
      await closeWorker()
      return
    }

    if (request.method === 'POST' && request.url === '/analyze') {
      if (internalSessionId) {
        sendJson(response, 409, {
          error: 'This isolated session was already analyzed.',
          code: 'invalid_action',
          sessionInvalidated: false,
        })
        return
      }
      const analysis = await service.analyze(config.target.url)
      internalSessionId = analysis.sessionId
      internalSessionToken = analysis.sessionToken
      sendJson(response, 200, analysis)
      return
    }

    if (request.method === 'POST' && request.url === '/action') {
      if (!internalSessionId) {
        sendJson(response, 409, {
          error: 'The isolated session has not been analyzed.',
          code: 'invalid_action',
          sessionInvalidated: false,
        })
        return
      }
      const body = await readBody(request)
      if (
        typeof body.toolName !== 'string'
        || typeof body.capabilityId !== 'string'
        || !body.input
        || typeof body.input !== 'object'
        || Array.isArray(body.input)
      ) throw new WrapperServiceError('invalid_action', 'capabilityId, toolName, and input are required.', 400)
      const result = await service.execute(
        internalSessionId,
        internalSessionToken,
        body.toolName,
        body.input as Record<string, unknown>,
        abortController.signal,
        body.capabilityId,
      )
      sendJson(response, 200, result)
      return
    }

    if (request.method === 'POST' && request.url === '/close') {
      sendJson(response, 200, { closed: true })
      await closeWorker()
      return
    }

    if (request.method === 'POST' && request.url === '/health') {
      sendJson(response, 200, { ready: true, analyzed: Boolean(internalSessionId) })
      return
    }

    sendJson(response, 404, {
      error: 'Unknown worker operation.',
      code: 'invalid_action',
      sessionInvalidated: false,
    })
  } catch (error) {
    if (abortController.signal.aborted) {
      await closeWorker()
      return
    }
    if (error instanceof WrapperServiceError && isPublicWrapperErrorCode(error.code)) {
      sendJson(response, error.status, {
        error: error.message,
        code: error.code,
        sessionInvalidated: error.sessionInvalidated ?? false,
      })
      return
    }
    process.stderr.write('[webmcp-wrapper-worker] unexpected internal failure\n')
    sendJson(response, 500, { error: 'The isolated browser operation failed.', code: 'internal_error' })
  } finally {
    request.off('aborted', abort)
    response.off('close', abort)
  }
})

server.listen(config.socketPath)
server.on('listening', () => process.stdout.write('READY\n'))
process.once('SIGTERM', () => void closeWorker())
process.once('SIGINT', () => void closeWorker())
