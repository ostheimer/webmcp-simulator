import { describe, expect, it, vi } from 'vitest'
import type { ProductionWrapperBackend } from './productionApi.ts'
import {
  handleActionRequest,
  handleAnalyzeRequest,
  handleCloseRequest,
  handleHealthRequest,
} from './productionApi.ts'
import { WRAPPER_MAX_REQUEST_BODY_BYTES, WRAPPER_MAX_RESPONSE_BYTES } from './wrapperLimits.ts'
import { WrapperServiceError } from './wrapperErrors.ts'

function request(
  path: string,
  body: unknown,
  options: {
    clientId?: string
    origin?: string
    signal?: AbortSignal
    method?: string
    sourceIp?: string
  } = {},
): Request {
  const clientId = options.clientId ?? 'client_1234567890abcdef'
  const sourceOctet = 1 + [...clientId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 200
  return new Request(`https://wrapper.example${path}`, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WebMCP-Client': clientId,
      'X-Vercel-Forwarded-For': options.sourceIp ?? `203.0.113.${sourceOctet}`,
      Origin: options.origin ?? 'https://wrapper.example',
      'Sec-Fetch-Site': 'same-origin',
    },
    body: JSON.stringify(body),
    signal: options.signal,
  })
}

function rawRequest(
  path: string,
  body: BodyInit,
  options: {
    clientId: string
    sourceIp: string
    signal?: AbortSignal
  },
): Request {
  return new Request(`https://wrapper.example${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-WebMCP-Client': options.clientId,
      'X-Vercel-Forwarded-For': options.sourceIp,
      Origin: 'https://wrapper.example',
      'Sec-Fetch-Site': 'same-origin',
    },
    body,
    signal: options.signal,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' })
}

function pendingAnalyzeRequest(options: { clientId: string, sourceIp: string }) {
  const encoder = new TextEncoder()
  let finish!: () => void
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('{"url":"https://public.example.at"'))
      finish = () => {
        controller.enqueue(encoder.encode('}'))
        controller.close()
      }
    },
  })
  return {
    request: rawRequest('/api/wrapper/analyze', body, options),
    finish,
  }
}

function backend(overrides: Partial<ProductionWrapperBackend> = {}): ProductionWrapperBackend {
  return {
    analyze: vi.fn(async () => ({ ok: true })),
    execute: vi.fn(async () => ({ ok: true })),
    closeSession: vi.fn(async () => true),
    ...overrides,
  }
}

describe('production wrapper API boundaries', () => {
  it('separates liveness from Sandbox readiness and reflects browser-source configuration', async () => {
    const unconfigured = handleHealthRequest({})
    expect(unconfigured.status).toBe(200)
    expect(await unconfigured.json()).toMatchObject({
      alive: true,
      ready: false,
      configuration: 'missing-browser-source',
    })

    const snapshot = handleHealthRequest({ snapshotId: 'snap_reviewed' })
    expect(await snapshot.json()).toMatchObject({ alive: true, ready: true, configuration: 'configured' })
    const image = handleHealthRequest({ image: 'docker.io/reviewed/browser:1' })
    expect(await image.json()).toMatchObject({ alive: true, ready: true, configuration: 'configured' })
  })

  it('rejects cross-origin requests before invoking the browser backend', async () => {
    const target = backend()
    const response = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { origin: 'https://attacker.example' }), target)
    expect(response.status).toBe(403)
    expect(target.analyze).not.toHaveBeenCalled()
  })

  it('fails closed when Vercel did not provide a trusted source address', async () => {
    const target = backend()
    const targetRequest = request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'missing_source_client_001' })
    targetRequest.headers.delete('X-Vercel-Forwarded-For')
    const response = await handleAnalyzeRequest(targetRequest, target)

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ code: 'source_identity' })
    expect(target.analyze).not.toHaveBeenCalled()
  })

  it('enforces the request body limit before invoking the backend', async () => {
    const target = backend()
    const response = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: `https://public.example.at/${'x'.repeat(WRAPPER_MAX_REQUEST_BODY_BYTES)}`,
    }, { clientId: 'body_limit_client_0001' }), target)
    expect(response.status).toBe(413)
    expect(target.analyze).not.toHaveBeenCalled()
  })

  it('enforces the response limit without returning oversized page evidence', async () => {
    const target = backend({
      analyze: vi.fn(async () => ({ evidence: 'x'.repeat(WRAPPER_MAX_RESPONSE_BYTES + 1) })),
    })
    const response = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'response_limit_client_01' }), target)
    expect(response.status).toBe(507)
    expect(await response.json()).toMatchObject({ code: 'response_limit' })
  })

  it('allows only one running analysis per client and rate-limits repeated starts', async () => {
    let release!: () => void
    let markStarted!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    const target = backend({ analyze: vi.fn(async () => { markStarted(); await pending; return { ok: true } }) })
    const first = handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'concurrent_client_0001' }), target)
    await started
    const second = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'concurrent_client_0001' }), target)
    expect(second.status).toBe(409)
    release()
    expect((await first).status).toBe(200)

    const rateTarget = backend()
    const statuses: number[] = []
    for (let index = 0; index < 5; index += 1) {
      statuses.push((await handleAnalyzeRequest(request('/api/wrapper/analyze', {
        url: 'https://public.example.at',
      }, { clientId: 'rate_limit_client_00001' }), rateTarget)).status)
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429])
  })

  it('reserves a trusted source before streamed body parsing and releases every parsing failure', async () => {
    const analyze = vi.fn(async () => ({ ok: true }))
    const target = backend({ analyze })
    const sourceIp = '198.51.100.91'
    const firstBody = pendingAnalyzeRequest({ clientId: 'streaming_client_000001', sourceIp })
    const secondBody = pendingAnalyzeRequest({ clientId: 'streaming_client_000002', sourceIp })
    const first = handleAnalyzeRequest(firstBody.request, target)
    const second = await handleAnalyzeRequest(secondBody.request, target)

    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({ code: 'analysis_in_progress' })
    expect(analyze).not.toHaveBeenCalled()
    secondBody.finish()
    firstBody.finish()
    expect((await first).status).toBe(200)
    expect(analyze).toHaveBeenCalledOnce()

    const invalidSource = '198.51.100.92'
    const invalid = await handleAnalyzeRequest(rawRequest(
      '/api/wrapper/analyze',
      '{',
      { clientId: 'invalid_json_client_0001', sourceIp: invalidSource },
    ), target)
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ code: 'invalid_json' })
    expect((await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'invalid_json_client_0002', sourceIp: invalidSource }), target)).status).toBe(200)

    const validationSource = '198.51.100.95'
    const invalidUrl = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 42,
    }, { clientId: 'invalid_url_client_00001', sourceIp: validationSource }), target)
    expect(invalidUrl.status).toBe(400)
    expect(await invalidUrl.json()).toMatchObject({ code: 'invalid_url' })
    expect((await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'invalid_url_client_00002', sourceIp: validationSource }), target)).status).toBe(200)

    const bodyLimitSource = '198.51.100.93'
    const oversized = await handleAnalyzeRequest(rawRequest(
      '/api/wrapper/analyze',
      'x'.repeat(WRAPPER_MAX_REQUEST_BODY_BYTES + 1),
      { clientId: 'body_release_client_001', sourceIp: bodyLimitSource },
    ), target)
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ code: 'body_limit' })
    expect((await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'body_release_client_002', sourceIp: bodyLimitSource }), target)).status).toBe(200)
  })

  it('releases the source reservation after an aborted backend analysis', async () => {
    const controller = new AbortController()
    const analyze = vi.fn(async (_url: string, signal?: AbortSignal) => {
      await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => {
        reject(new DOMException('Aborted', 'AbortError'))
      }, { once: true }))
    })
    const target = backend({ analyze })
    const sourceIp = '198.51.100.94'
    const first = handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'abort_analysis_client_01', sourceIp, signal: controller.signal }), target)
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce())
    controller.abort()
    expect((await first).status).toBe(499)

    const retry = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'abort_analysis_client_02', sourceIp }), backend())
    expect(retry.status).toBe(200)
  })

  it('does not let rotated browser client identifiers bypass the trusted-source rate guard', async () => {
    const target = backend()
    const statuses: number[] = []
    for (let index = 0; index < 5; index += 1) {
      statuses.push((await handleAnalyzeRequest(request('/api/wrapper/analyze', {
        url: 'https://public.example.at',
      }, {
        clientId: `rotated_client_${String(index).padStart(8, '0')}`,
        sourceIp: '198.51.100.77',
      }), target)).status)
    }
    expect(statuses).toEqual([200, 200, 200, 200, 429])
  })

  it('requires and forwards the separate capability for actions and close', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const closeSession = vi.fn(async () => false)
    const target = backend({ execute, closeSession })
    const action = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      toolName: 'prepare_page_search',
      input: { query: 'heat pump' },
    }, { clientId: 'action_client_00000001' }), target)
    expect(action.status).toBe(200)
    expect(execute).toHaveBeenCalledWith(
      'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      'A'.repeat(43),
      'prepare_page_search',
      { query: 'heat pump' },
      expect.any(AbortSignal),
    )

    const close = await handleCloseRequest(request('/api/wrapper/session', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'B'.repeat(43),
    }, { clientId: 'close_client_000000001', method: 'DELETE' }), target)
    expect(close.status).toBe(401)
    expect(closeSession).toHaveBeenCalledOnce()
  })

  it('propagates request abort and reports structured provider capacity failures honestly', async () => {
    const controller = new AbortController()
    const aborting = backend({
      execute: vi.fn(async (_id, _token, _tool, _input, signal) => {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true }))
      }),
    })
    const responsePromise = handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      toolName: 'prepare_page_search',
      input: { query: 'x' },
    }, { clientId: 'abort_client_000000001', signal: controller.signal }), aborting)
    controller.abort()
    expect((await responsePromise).status).toBe(499)

    const quota = backend({
      analyze: vi.fn(async () => {
        throw new WrapperServiceError(
          'sandbox_capacity',
          'The isolated browser capacity is temporarily unavailable.',
          503,
        )
      }),
    })
    const quotaResponse = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'quota_client_000000001' }), quota)
    expect(quotaResponse.status).toBe(503)
    expect(await quotaResponse.json()).toMatchObject({ code: 'sandbox_capacity' })
  })

  it('reports the ten-page policy as page_limit rather than provider capacity', async () => {
    const target = backend({
      execute: vi.fn(async () => {
        throw new WrapperServiceError(
          'page_limit',
          'This session reached its 10-page analysis limit.',
          422,
        )
      }),
    })
    const response = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      toolName: 'open_page_link',
      input: { linkIndex: 0 },
    }, { clientId: 'page_limit_client_000001' }), target)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'This session reached its 10-page analysis limit.',
      code: 'page_limit',
    })
  })

  it('does not return or log sensitive details from unexpected internal failures', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const target = backend({
      analyze: vi.fn(async () => {
        throw new Error('sandbox webmcp-wrapper-secret at /opt/worker contains agent-secret')
      }),
    })
    const response = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, { clientId: 'internal_error_client_001' }), target)
    const body = JSON.stringify(await response.json())

    expect(response.status).toBe(500)
    expect(body).toBe(JSON.stringify({
      error: 'The isolated browser operation failed.',
      code: 'internal_error',
    }))
    expect(body).not.toMatch(/webmcp-wrapper-secret|\/opt\/worker|agent-secret/)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/webmcp-wrapper-secret|\/opt\/worker|agent-secret/)
    log.mockRestore()
  })
})
