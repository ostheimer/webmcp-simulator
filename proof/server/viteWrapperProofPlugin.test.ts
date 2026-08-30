import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createViteServer } from 'vite'
import { describe, expect, it, vi } from 'vitest'
import type { PublicTarget } from './publicTarget.ts'
import { WrapperServiceError } from './wrapperErrors.ts'
import { WrapperProofService } from './wrapperService.ts'
import { localPublicError, wrapperProofPlugin } from './viteWrapperProofPlugin.ts'

function activeSessionCount(service: WrapperProofService): number {
  return (service as unknown as { sessions: Map<string, unknown> }).sessions.size
}

describe('local wrapper API error boundary', () => {
  it('preserves invalid input and stale capability errors without retiring the local session', () => {
    expect(localPublicError(new WrapperServiceError(
      'invalid_action',
      'query must be non-empty.',
      400,
      { sessionInvalidated: false },
    ), true)).toEqual({
      status: 400,
      body: {
        error: 'query must be non-empty.',
        code: 'invalid_action',
        sessionInvalidated: false,
      },
    })
    expect(localPublicError(new WrapperServiceError(
      'invalid_action',
      'The requested tool belongs to a stale page analysis.',
      409,
      { sessionInvalidated: false },
    ), true).body.sessionInvalidated).toBe(false)
  })

  it('propagates trusted post-mutation invalidation and sanitizes unknown failures', () => {
    expect(localPublicError(new WrapperServiceError(
      'action_failed',
      'The isolated page could not safely verify the requested action.',
      409,
      { sessionInvalidated: true },
    ), true)).toEqual({
      status: 409,
      body: {
        error: 'The isolated page could not safely verify the requested action.',
        code: 'action_failed',
        sessionInvalidated: true,
      },
    })

    expect(localPublicError(new WrapperServiceError(
      'invalid_action',
      'An action error without a trusted lifecycle signal.',
      409,
    ), true).body.sessionInvalidated).toBe(true)

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const safe = localPublicError(new Error('secret path /opt/worker and session token'), true)
    expect(safe).toEqual({
      status: 500,
      body: {
        error: 'The isolated browser operation failed.',
        code: 'internal_error',
        sessionInvalidated: true,
      },
    })
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret path|\/opt\/worker|session token/)
    log.mockRestore()
  })

  it('cancels delayed local analyses without leaving Chromium sessions or capacity state behind', async () => {
    let slowRequests = 0
    const targetServer = createHttpServer((request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      if (request.url === '/slow-document') {
        slowRequests += 1
        response.write('<!doctype html><title>Delayed analysis</title><main>')
        const timeout = setTimeout(() => response.end('</main>'), 5_000)
        response.once('close', () => clearTimeout(timeout))
        return
      }
      response.end('<!doctype html><title>Normal analysis</title><input type="search" aria-label="Search locally">')
    })
    targetServer.listen(0, '127.0.0.1')
    await once(targetServer, 'listening')
    const targetAddress = targetServer.address()
    if (!targetAddress || typeof targetAddress === 'string') throw new Error('Target fixture did not expose a port.')
    const targetOrigin = `http://proof.example.at:${targetAddress.port}`
    const resolveTarget = async (value: string): Promise<PublicTarget> => {
      const url = new URL(value)
      return {
        url: url.toString(),
        origin: url.origin,
        hostname: url.hostname,
        pinnedAddress: '127.0.0.1',
        addresses: [{ address: '127.0.0.1', family: 4 }],
      }
    }
    const service = new WrapperProofService({ resolveTarget, actionSettleMs: 20 })
    const vite = await createViteServer({
      appType: 'custom',
      configFile: false,
      logLevel: 'silent',
      plugins: [wrapperProofPlugin(service)],
      server: { host: '127.0.0.1', port: 0 },
    })
    await vite.listen()
    const viteAddress = vite.httpServer?.address()
    if (!viteAddress || typeof viteAddress === 'string') throw new Error('Vite fixture did not expose a port.')
    const apiOrigin = `http://127.0.0.1:${viteAddress.port}`
    const headers = {
      'Content-Type': 'application/json',
      'X-WebMCP-Client': 'local-abort-client-01',
    }

    try {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const controller = new AbortController()
        const pending = fetch(`${apiOrigin}/api/wrapper/analyze`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ url: `${targetOrigin}/slow-document` }),
          signal: controller.signal,
        })
        await vi.waitFor(() => expect(slowRequests).toBe(attempt), { timeout: 3_000 })
        controller.abort()
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
        await vi.waitFor(() => expect(activeSessionCount(service)).toBe(0), { timeout: 2_000 })
      }

      const normalResponse = await fetch(`${apiOrigin}/api/wrapper/analyze`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ url: `${targetOrigin}/` }),
      })
      expect(normalResponse.status).toBe(200)
      const analysis = await normalResponse.json() as { sessionId: string, sessionToken: string, title: string }
      expect(analysis.title).toBe('Normal analysis')
      expect(activeSessionCount(service)).toBe(1)

      const closeResponse = await fetch(`${apiOrigin}/api/wrapper/session`, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ sessionId: analysis.sessionId, sessionToken: analysis.sessionToken }),
      })
      expect(closeResponse.status).toBe(200)
      expect(activeSessionCount(service)).toBe(0)
    } finally {
      await vite.close()
      await service.close()
      targetServer.close()
      await once(targetServer, 'close')
    }
  })
})
