import { describe, expect, it, vi } from 'vitest'
import type { WrapperActionResult, WrapperAnalysis } from '../../src/features/wrapper/types.ts'
import type { ProductionWrapperBackend } from './productionApi.ts'
import {
  BoundedRateStore,
  handleActionRequest,
  handleAnalyzeRequest,
  handleCloseRequest,
  handleHealthRequest,
} from './productionApi.ts'
import {
  WRAPPER_MAX_REQUEST_BODY_BYTES,
  WRAPPER_MAX_RESPONSE_BYTES,
  WRAPPER_MAX_SCREENSHOT_BYTES,
} from './wrapperLimits.ts'
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
    contentType?: string
    secFetchSite?: string
  } = {},
): Request {
  const clientId = options.clientId ?? 'client_1234567890abcdef'
  const sourceOctet = 1 + [...clientId].reduce((sum, character) => sum + character.charCodeAt(0), 0) % 200
  return new Request(`https://wrapper.example${path}`, {
    method: options.method ?? 'POST',
    headers: {
      'Content-Type': options.contentType ?? 'application/json',
      'X-WebMCP-Client': clientId,
      'X-Vercel-Forwarded-For': options.sourceIp ?? `203.0.113.${sourceOctet}`,
      Origin: options.origin ?? 'https://wrapper.example',
      'Sec-Fetch-Site': options.secFetchSite ?? 'same-origin',
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

function pendingAnalyzeRequest(options: { clientId: string, sourceIp: string, signal?: AbortSignal }) {
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

function pendingActionRequest(options: { clientId: string, sourceIp: string, signal?: AbortSignal }) {
  const encoder = new TextEncoder()
  let finish!: () => void
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({
        sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
        sessionToken: 'A'.repeat(43),
        capabilityId: 'capability-streamed-action',
        toolName: 'prepare_page_search',
        input: { query: 'safe' },
      }).slice(0, -1)))
      finish = () => {
        controller.enqueue(encoder.encode('}'))
        controller.close()
      }
    },
  })
  return {
    request: rawRequest('/api/wrapper/action', body, options),
    finish,
  }
}

function observeBodyAccess(targetRequest: Request): { request: Request, count: () => number } {
  const body = targetRequest.body
  let accesses = 0
  Object.defineProperty(targetRequest, 'body', {
    configurable: true,
    get() {
      accesses += 1
      return body
    },
  })
  return { request: targetRequest, count: () => accesses }
}

function healthRequest(method = 'GET'): Request {
  return new Request('https://wrapper.example/api/wrapper/health', { method })
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
  it('prunes expired rate identities and rejects new identities at a hard capacity', () => {
    let now = 1_000
    const store = new BoundedRateStore(2, () => now)

    expect(store.consume('source-a', 2, 100)).toBe('allowed')
    expect(store.consume('source-b', 2, 1_000)).toBe('allowed')
    expect(store.size).toBe(2)
    expect(store.consume('source-c', 2, 1_000)).toBe('capacity')
    expect(store.size).toBe(2)

    expect(store.consume('source-a', 2, 100)).toBe('allowed')
    expect(store.consume('source-a', 2, 100)).toBe('limited')
    now = 1_101
    expect(store.consume('source-c', 2, 1_000)).toBe('allowed')
    expect(store.size).toBe(2)
    expect(store.consume('source-b', 2, 1_000)).toBe('allowed')
    expect(store.consume('source-d', 2, 1_000)).toBe('capacity')
  })

  it('separates liveness from Sandbox readiness and reflects browser-source configuration', async () => {
    const unconfigured = handleHealthRequest(healthRequest(), {})
    expect(unconfigured.status).toBe(200)
    expect(await unconfigured.json()).toMatchObject({
      alive: true,
      ready: false,
      configuration: 'missing-browser-source',
    })

    const snapshot = handleHealthRequest(healthRequest(), { snapshotId: 'snap_reviewed' })
    expect(await snapshot.json()).toMatchObject({ alive: true, ready: true, configuration: 'configured' })
    const image = handleHealthRequest(healthRequest(), { image: 'docker.io/reviewed/browser:1' })
    expect(await image.json()).toMatchObject({ alive: true, ready: true, configuration: 'configured' })
  })

  it('enforces endpoint methods before source, rate, body, concurrency, or backend work', async () => {
    const analyze = vi.fn(async () => ({ ok: true }))
    const analyzeTarget = backend({ analyze })
    const analyzeBody = { url: 'https://public.example.at' }
    const analyzeOptions = {
      clientId: 'method_analyze_client_001',
      sourceIp: '198.51.100.241',
    }
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const observed = observeBodyAccess(request('/api/wrapper/analyze', analyzeBody, {
        ...analyzeOptions,
        method,
      }))
      observed.request.headers.delete('X-Vercel-Forwarded-For')
      const response = await handleAnalyzeRequest(observed.request, analyzeTarget)
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('POST')
      expect(await response.json()).toEqual({
        error: 'This wrapper API endpoint does not support the requested method.',
        code: 'method_not_allowed',
      })
      expect(observed.count()).toBe(0)
    }
    for (let index = 0; index < 4; index += 1) {
      expect((await handleAnalyzeRequest(request('/api/wrapper/analyze', analyzeBody, analyzeOptions), analyzeTarget)).status)
        .toBe(200)
    }
    expect((await handleAnalyzeRequest(request('/api/wrapper/analyze', analyzeBody, analyzeOptions), analyzeTarget)).status)
      .toBe(429)
    expect(analyze).toHaveBeenCalledTimes(4)

    const execute = vi.fn(async () => ({ ok: true }))
    const actionTarget = backend({ execute })
    const actionBody = {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-method-boundary',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }
    const actionOptions = {
      clientId: 'method_action_client_0001',
      sourceIp: '198.51.100.242',
    }
    for (const method of ['DELETE', 'PATCH', 'PUT']) {
      const observed = observeBodyAccess(request('/api/wrapper/action', actionBody, {
        ...actionOptions,
        method,
      }))
      observed.request.headers.delete('X-Vercel-Forwarded-For')
      const response = await handleActionRequest(observed.request, actionTarget)
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('POST')
      expect(await response.json()).toEqual({
        error: 'This wrapper API endpoint does not support the requested method.',
        code: 'method_not_allowed',
        sessionInvalidated: false,
      })
      expect(observed.count()).toBe(0)
    }
    for (let index = 0; index < 30; index += 1) {
      expect((await handleActionRequest(request('/api/wrapper/action', actionBody, actionOptions), actionTarget)).status)
        .toBe(200)
    }
    expect((await handleActionRequest(request('/api/wrapper/action', actionBody, actionOptions), actionTarget)).status)
      .toBe(429)
    expect(execute).toHaveBeenCalledTimes(30)

    const closeSession = vi.fn(async () => true)
    const closeTarget = backend({ closeSession })
    const closeBody = {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'B'.repeat(43),
    }
    const closeOptions = {
      clientId: 'method_close_client_00001',
      sourceIp: '198.51.100.243',
    }
    for (const method of ['PATCH', 'POST', 'PUT']) {
      const observed = observeBodyAccess(request('/api/wrapper/session', closeBody, {
        ...closeOptions,
        method,
      }))
      observed.request.headers.delete('X-Vercel-Forwarded-For')
      const response = await handleCloseRequest(observed.request, closeTarget)
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('DELETE')
      expect(await response.json()).toEqual({
        error: 'This wrapper API endpoint does not support the requested method.',
        code: 'method_not_allowed',
      })
      expect(observed.count()).toBe(0)
    }
    for (let index = 0; index < 30; index += 1) {
      expect((await handleCloseRequest(request('/api/wrapper/session', closeBody, {
        ...closeOptions,
        method: 'DELETE',
      }), closeTarget)).status).toBe(200)
    }
    expect((await handleCloseRequest(request('/api/wrapper/session', closeBody, {
      ...closeOptions,
      method: 'DELETE',
    }), closeTarget)).status).toBe(429)
    expect(closeSession).toHaveBeenCalledTimes(30)

    for (const method of ['OPTIONS', 'POST', 'PUT']) {
      const response = handleHealthRequest(healthRequest(method), {})
      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('GET')
      expect(await response.json()).toEqual({
        error: 'This wrapper API endpoint does not support the requested method.',
        code: 'method_not_allowed',
      })
    }
    expect(handleHealthRequest(healthRequest(), {}).status).toBe(200)
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

  it('serializes a critical-size action screenshot exactly once below the API limit', async () => {
    const jpegBytes = 850 * 1024
    expect(jpegBytes).toBeLessThanOrEqual(WRAPPER_MAX_SCREENSHOT_BYTES)
    const criticalScreenshot = `data:image/jpeg;base64,${Buffer.alloc(jpegBytes).toString('base64')}`
    const analysis: WrapperAnalysis = {
      sessionId: 'session-critical-size',
      sessionToken: 'token-critical-size',
      requestedUrl: 'https://public.example.at/',
      finalUrl: 'https://public.example.at/',
      title: 'Critical screenshot fixture',
      screenshotDataUrl: criticalScreenshot,
      domEvidence: [],
      axEvidence: [],
      capabilities: [],
      warnings: [],
      blockedRequests: 0,
      analyzedPages: 1,
      maxPages: 10,
      expiresAt: '2026-08-30T10:05:00.000Z',
      runtime: {
        provider: 'vercel-sandbox',
        runtimeMs: 100,
        vcpus: 2,
        memoryMb: 4096,
        allowedNetworkRequests: 1,
        blockedNetworkRequests: 0,
        estimatedCost: {
          currency: 'USD',
          lowerBound: 0,
          upperBound: 0.0001,
          basis: 'illustrative-list-price',
        },
      },
      createdAt: '2026-08-30T10:00:00.000Z',
    }
    const action: WrapperActionResult = {
      finalUrl: analysis.finalUrl,
      analysis,
      activity: {
        id: 'activity-critical-size',
        toolName: 'prepare_page_search',
        summary: 'Prepared.',
        createdAt: analysis.createdAt,
      },
      structuredContent: {
        toolName: 'prepare_page_search',
        actionKind: 'prepare_search',
        finalUrl: analysis.finalUrl,
        isolatedStateChanged: true,
        targetStateVerified: true,
        networkPolicy: 'blocked-after-preparation',
        blockedNetworkRequests: 0,
        allowedNetworkRequests: 0,
        formSubmissionPrevented: true,
        navigationOccurred: false,
      },
    }
    const target = backend({
      analyze: vi.fn(async () => analysis),
      execute: vi.fn(async () => action),
    })
    const options = {
      clientId: 'critical_screenshot_client_01',
      sourceIp: '198.51.100.211',
    }

    const analysisResponse = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: analysis.requestedUrl,
    }, options), target)
    expect(analysisResponse.status).toBe(200)
    expect(Buffer.byteLength(await analysisResponse.clone().text())).toBeLessThan(WRAPPER_MAX_RESPONSE_BYTES)

    const actionResponse = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: analysis.sessionId,
      sessionToken: analysis.sessionToken,
      capabilityId: 'capability-critical-size',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }, options), target)
    expect(actionResponse.status).toBe(200)
    const actionText = await actionResponse.text()
    expect(Buffer.byteLength(actionText)).toBeLessThan(WRAPPER_MAX_RESPONSE_BYTES)
    expect(actionText.match(/data:image\/jpeg;base64/g)).toHaveLength(1)
    const actionBody = JSON.parse(actionText) as Record<string, unknown>
    expect(actionBody).not.toHaveProperty('screenshotDataUrl')
    expect(actionBody).not.toHaveProperty('sessionInvalidated')
    expect(actionBody).toMatchObject({
      analysis: { screenshotDataUrl: criticalScreenshot },
    })
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

  it('applies the absolute analysis deadline to streamed bodies and releases the source reservation', async () => {
    const analyze = vi.fn(async () => ({ ok: true }))
    const target = backend({ analyze })
    const sourceIp = '198.51.100.96'
    const slowBody = pendingAnalyzeRequest({
      clientId: 'deadline_stream_client_01',
      sourceIp,
    })

    const timedOut = await handleAnalyzeRequest(slowBody.request, target, { analysisTimeoutMs: 20 })
    expect(timedOut.status).toBe(504)
    expect(await timedOut.json()).toEqual({
      error: 'The isolated browser analysis exceeded its fixed time limit.',
      code: 'analysis_timeout',
    })
    expect(analyze).not.toHaveBeenCalled()

    const retry = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, {
      clientId: 'deadline_stream_client_02',
      sourceIp,
    }), target, { analysisTimeoutMs: 1_000 })
    expect(retry.status).toBe(200)
    expect(analyze).toHaveBeenCalledOnce()
  })

  it('distinguishes a client-aborted streamed body from the absolute analysis deadline', async () => {
    const controller = new AbortController()
    const analyze = vi.fn(async () => ({ ok: true }))
    const target = backend({ analyze })
    const sourceIp = '198.51.100.97'
    const slowBody = pendingAnalyzeRequest({
      clientId: 'cancel_stream_client_0001',
      sourceIp,
      signal: controller.signal,
    })
    const pending = handleAnalyzeRequest(slowBody.request, target, { analysisTimeoutMs: 1_000 })
    controller.abort()

    const cancelled = await pending
    expect(cancelled.status).toBe(499)
    expect(await cancelled.json()).toEqual({
      error: 'The isolated browser operation was cancelled.',
      code: 'cancelled',
    })
    expect(analyze).not.toHaveBeenCalled()

    const retry = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, {
      clientId: 'cancel_stream_client_0002',
      sourceIp,
    }), target, { analysisTimeoutMs: 1_000 })
    expect(retry.status).toBe(200)
    expect(analyze).toHaveBeenCalledOnce()
  })

  it('closes a late backend result after timeout without retaining the trusted-source slot', async () => {
    let resolveLate!: (value: { sessionId: string, sessionToken: string }) => void
    const analyze = vi.fn(async () => new Promise<{ sessionId: string, sessionToken: string }>((resolve) => {
      resolveLate = resolve
    }))
    const closeSession = vi.fn(async () => true)
    const target = backend({ analyze, closeSession })
    const sourceIp = '198.51.100.98'
    const first = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, {
      clientId: 'late_result_client_00001',
      sourceIp,
    }), target, { analysisTimeoutMs: 20 })
    expect(first.status).toBe(504)

    const retryTarget = backend()
    expect((await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, {
      clientId: 'late_result_client_00002',
      sourceIp,
    }), retryTarget, { analysisTimeoutMs: 1_000 })).status).toBe(200)

    resolveLate({ sessionId: 'late-session-id', sessionToken: 'late-session-token' })
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce())
    expect(closeSession).toHaveBeenCalledWith('late-session-id', 'late-session-token')
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
      capabilityId: 'capability-test-action',
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
      'capability-test-action',
    )

    const close = await handleCloseRequest(request('/api/wrapper/session', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'B'.repeat(43),
    }, { clientId: 'close_client_000000001', method: 'DELETE' }), target)
    expect(close.status).toBe(401)
    expect(closeSession).toHaveBeenCalledOnce()
  })

  it('rate-limits close attempts by trusted source only after a valid bounded body', async () => {
    const closeSession = vi.fn(async () => true)
    const target = backend({ closeSession })
    const sourceIp = '198.51.100.141'

    for (let index = 0; index < 40; index += 1) {
      const invalid = await handleCloseRequest(request('/api/wrapper/session', {
        sessionId: `missing-token-${index}`,
      }, {
        clientId: `invalid_close_${String(index).padStart(8, '0')}`,
        sourceIp,
        method: 'DELETE',
      }), target)
      expect(invalid.status).toBe(400)
    }
    expect(closeSession).not.toHaveBeenCalled()

    const statuses: number[] = []
    for (let index = 0; index < 31; index += 1) {
      statuses.push((await handleCloseRequest(request('/api/wrapper/session', {
        sessionId: `webmcp-wrapper-random-${String(index).padStart(8, '0')}`,
        sessionToken: `${String(index).padStart(2, '0')}${'A'.repeat(41)}`,
      }, {
        clientId: `rotated_close_${String(index).padStart(8, '0')}`,
        sourceIp,
        method: 'DELETE',
      }), target)).status)
    }
    expect(statuses).toEqual([...Array.from({ length: 30 }, () => 200), 429])
    expect(closeSession).toHaveBeenCalledTimes(30)
  })

  it('returns a sanitized typed production analysis timeout', async () => {
    const target = backend({
      analyze: vi.fn(async () => {
        throw new WrapperServiceError(
          'analysis_timeout',
          'The isolated website analysis exceeded its fixed time limit.',
          504,
        )
      }),
    })
    const response = await handleAnalyzeRequest(request('/api/wrapper/analyze', {
      url: 'https://public.example.at',
    }, {
      clientId: 'analysis_timeout_client01',
      sourceIp: '198.51.100.142',
    }), target)
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: 'The isolated website analysis exceeded its fixed time limit.',
      code: 'analysis_timeout',
    })
  })

  it('returns a sanitized invalidating production action timeout', async () => {
    const target = backend({
      execute: vi.fn(async () => {
        throw new WrapperServiceError(
          'action_timeout',
          'The isolated browser action exceeded its fixed time limit.',
          504,
          { sessionInvalidated: true },
        )
      }),
    })
    const response = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-action-timeout',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }, {
      clientId: 'action_timeout_client_001',
      sourceIp: '198.51.100.244',
    }), target)
    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: 'The isolated browser action exceeded its fixed time limit.',
      code: 'action_timeout',
      sessionInvalidated: true,
    })
  })

  it('applies the absolute action deadline to streamed bodies without touching the session', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const target = backend({ execute })
    const sourceIp = '198.51.100.245'
    const slowBody = pendingActionRequest({
      clientId: 'action_deadline_stream_01',
      sourceIp,
    })

    const timedOut = await handleActionRequest(slowBody.request, target, { actionTimeoutMs: 20 })
    expect(timedOut.status).toBe(504)
    expect(await timedOut.json()).toEqual({
      error: 'The isolated browser action exceeded its fixed time limit.',
      code: 'action_timeout',
      sessionInvalidated: false,
    })
    expect(execute).not.toHaveBeenCalled()

    const retry = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-streamed-action',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }, {
      clientId: 'action_deadline_stream_02',
      sourceIp,
    }), target, { actionTimeoutMs: 1_000 })
    expect(retry.status).toBe(200)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('distinguishes a client-aborted action body from the action deadline', async () => {
    const controller = new AbortController()
    const execute = vi.fn(async () => ({ ok: true }))
    const target = backend({ execute })
    const slowBody = pendingActionRequest({
      clientId: 'action_cancel_stream_001',
      sourceIp: '198.51.100.246',
      signal: controller.signal,
    })
    const pending = handleActionRequest(slowBody.request, target, { actionTimeoutMs: 1_000 })
    controller.abort()

    const cancelled = await pending
    expect(cancelled.status).toBe(499)
    expect(await cancelled.json()).toEqual({
      error: 'The isolated browser operation was cancelled.',
      code: 'cancelled',
      sessionInvalidated: false,
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('invalidates and closes a late action result when the handler deadline expires after backend start', async () => {
    let resolveLate!: (value: unknown) => void
    const execute = vi.fn(async () => new Promise<unknown>((resolve) => {
      resolveLate = resolve
    }))
    const closeSession = vi.fn(async () => true)
    const target = backend({ execute, closeSession })
    const response = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-late-action',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }, {
      clientId: 'action_late_result_0001',
      sourceIp: '198.51.100.247',
    }), target, { actionTimeoutMs: 20 })

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: 'The isolated browser action exceeded its fixed time limit.',
      code: 'action_timeout',
      sessionInvalidated: true,
    })
    expect(execute).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce())
    expect(closeSession).toHaveBeenCalledWith(
      'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      'A'.repeat(43),
    )

    resolveLate({
      finalUrl: 'https://public.example.at/',
      analysis: {
        sessionId: 'late-action-session',
        sessionToken: 'late-action-token',
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(closeSession).toHaveBeenCalledOnce()
  })

  it('does not return success when the absolute action deadline expires during response serialization', async () => {
    const closeSession = vi.fn(async () => true)
    const target = backend({
      closeSession,
      execute: vi.fn(async () => ({
        analysis: {
          sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
          sessionToken: 'A'.repeat(43),
        },
        toJSON() {
          const stopAt = Date.now() + 20
          while (Date.now() < stopAt) { /* deterministic synchronous response stall */ }
          return { ok: true }
        },
      })),
    })
    const response = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-response-deadline',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }, {
      clientId: 'action_response_deadline_1',
      sourceIp: '198.51.100.248',
    }), target, { actionTimeoutMs: 5 })

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: 'The isolated browser action exceeded its fixed time limit.',
      code: 'action_timeout',
      sessionInvalidated: true,
    })
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce())
  })

  it('keeps timeout and cleanup semantics when response serialization throws after the action deadline', async () => {
    const closeSession = vi.fn(async () => true)
    const target = backend({
      closeSession,
      execute: vi.fn(async () => ({
        toJSON() {
          const stopAt = Date.now() + 20
          while (Date.now() < stopAt) { /* deterministic synchronous response stall */ }
          throw new Error('hostile serialization detail')
        },
      })),
    })
    const response = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-response-throw',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }, {
      clientId: 'action_response_throw_001',
      sourceIp: '198.51.100.249',
    }), target, { actionTimeoutMs: 5 })

    expect(response.status).toBe(504)
    expect(await response.json()).toEqual({
      error: 'The isolated browser action exceeded its fixed time limit.',
      code: 'action_timeout',
      sessionInvalidated: true,
    })
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce())
  })

  it('marks only typed pre-backend action failures as non-invalidating', async () => {
    const validBody = {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-pre-backend',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }
    const cases: Array<{ name: string, targetRequest: Request, code: string, status: number }> = [
      {
        name: 'content type',
        targetRequest: request('/api/wrapper/action', validBody, {
          clientId: 'prebackend_content_001',
          sourceIp: '198.51.100.121',
          contentType: 'text/plain',
        }),
        code: 'content_type',
        status: 415,
      },
      {
        name: 'cross-site',
        targetRequest: request('/api/wrapper/action', validBody, {
          clientId: 'prebackend_crosssite_1',
          sourceIp: '198.51.100.122',
          secFetchSite: 'cross-site',
        }),
        code: 'cross_site',
        status: 403,
      },
      {
        name: 'origin',
        targetRequest: request('/api/wrapper/action', validBody, {
          clientId: 'prebackend_origin_0001',
          sourceIp: '198.51.100.123',
          origin: 'https://attacker.example',
        }),
        code: 'origin_mismatch',
        status: 403,
      },
      {
        name: 'client id',
        targetRequest: request('/api/wrapper/action', validBody, {
          clientId: 'short',
          sourceIp: '198.51.100.124',
        }),
        code: 'client_id',
        status: 400,
      },
      {
        name: 'body limit',
        targetRequest: rawRequest('/api/wrapper/action', 'x'.repeat(WRAPPER_MAX_REQUEST_BODY_BYTES + 1), {
          clientId: 'prebackend_bodylimit_1',
          sourceIp: '198.51.100.125',
        }),
        code: 'body_limit',
        status: 413,
      },
      {
        name: 'malformed JSON',
        targetRequest: rawRequest('/api/wrapper/action', '{', {
          clientId: 'prebackend_json_00001',
          sourceIp: '198.51.100.126',
        }),
        code: 'invalid_json',
        status: 400,
      },
      {
        name: 'required fields',
        targetRequest: request('/api/wrapper/action', { sessionId: validBody.sessionId }, {
          clientId: 'prebackend_fields_0001',
          sourceIp: '198.51.100.127',
        }),
        code: 'invalid_action',
        status: 400,
      },
    ]

    for (const testCase of cases) {
      const target = backend()
      const response = await handleActionRequest(testCase.targetRequest, target)
      expect(response.status, testCase.name).toBe(testCase.status)
      expect(await response.json(), testCase.name).toMatchObject({
        code: testCase.code,
        sessionInvalidated: false,
      })
      expect(target.execute, testCase.name).not.toHaveBeenCalled()
    }
  })

  it('marks the 31st action rate-limit rejection as non-invalidating without calling the backend', async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const target = backend({ execute })
    const body = {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-rate-limit',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }
    const options = {
      clientId: 'action_rate_limit_00001',
      sourceIp: '198.51.100.128',
    }
    for (let index = 0; index < 30; index += 1) {
      expect((await handleActionRequest(request('/api/wrapper/action', body, options), target)).status).toBe(200)
    }
    expect(execute).toHaveBeenCalledTimes(30)

    const limited = await handleActionRequest(request('/api/wrapper/action', body, options), target)
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({
      error: 'The wrapper rate limit was reached. Try again after the current window.',
      code: 'rate_limit',
      sessionInvalidated: false,
    })
    expect(execute).toHaveBeenCalledTimes(30)
  })

  it('keeps backend and abort failures fail-closed after action acceptance', async () => {
    const body = {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-backend-control',
      toolName: 'prepare_page_search',
      input: { query: 'safe' },
    }
    const unknown = backend({ execute: vi.fn(async () => { throw new Error('internal backend detail') }) })
    const unknownResponse = await handleActionRequest(request('/api/wrapper/action', body, {
      clientId: 'backend_unknown_000001',
      sourceIp: '198.51.100.129',
    }), unknown)
    expect(await unknownResponse.json()).toEqual({
      error: 'The isolated browser operation failed.',
      code: 'internal_error',
    })

    const controller = new AbortController()
    controller.abort()
    const aborted = backend({ execute: vi.fn(async () => { throw new DOMException('Aborted', 'AbortError') }) })
    const abortedResponse = await handleActionRequest(request('/api/wrapper/action', body, {
      clientId: 'backend_abort_0000001',
      sourceIp: '198.51.100.130',
      signal: controller.signal,
    }), aborted)
    expect(await abortedResponse.json()).toEqual({
      error: 'The isolated browser operation was cancelled.',
      code: 'cancelled',
      sessionInvalidated: false,
    })
  })

  it('propagates request abort and reports structured provider capacity failures honestly', async () => {
    const controller = new AbortController()
    const closeSession = vi.fn(async () => true)
    const aborting = backend({
      closeSession,
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
      capabilityId: 'capability-test-abort',
      toolName: 'prepare_page_search',
      input: { query: 'x' },
    }, { clientId: 'abort_client_000000001', signal: controller.signal }), aborting)
    await vi.waitFor(() => expect(aborting.execute).toHaveBeenCalledOnce())
    controller.abort()
    const aborted = await responsePromise
    expect(aborted.status).toBe(499)
    expect(await aborted.json()).toEqual({
      error: 'The isolated browser operation was cancelled.',
      code: 'cancelled',
      sessionInvalidated: true,
    })
    await vi.waitFor(() => expect(closeSession).toHaveBeenCalledOnce())
    expect(closeSession).toHaveBeenCalledWith(
      'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      'A'.repeat(43),
    )

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
      capabilityId: 'capability-test-limit',
      toolName: 'open_page_link',
      input: { linkIndex: 0 },
    }, { clientId: 'page_limit_client_000001' }), target)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual({
      error: 'This session reached its 10-page analysis limit.',
      code: 'page_limit',
    })
  })

  it('exposes only the trusted session invalidation boolean from action errors', async () => {
    const invalidated = backend({
      execute: vi.fn(async () => {
        throw new WrapperServiceError(
          'action_failed',
          'The isolated browser operation failed.',
          500,
          { sessionInvalidated: true },
        )
      }),
    })
    const invalidatedResponse = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-invalidated',
      toolName: 'prepare_page_search',
      input: { query: 'x' },
    }, { clientId: 'invalidated_client_0001' }), invalidated)
    expect(invalidatedResponse.status).toBe(500)
    expect(await invalidatedResponse.json()).toEqual({
      error: 'The isolated browser operation failed.',
      code: 'action_failed',
      sessionInvalidated: true,
    })

    const preserved = backend({
      execute: vi.fn(async () => {
        throw new WrapperServiceError(
          'invalid_action',
          'The requested input is invalid.',
          400,
          { sessionInvalidated: false },
        )
      }),
    })
    const preservedResponse = await handleActionRequest(request('/api/wrapper/action', {
      sessionId: 'webmcp-wrapper-abcdefghijklmnopqrstuvwx',
      sessionToken: 'A'.repeat(43),
      capabilityId: 'capability-preserved',
      toolName: 'prepare_page_search',
      input: { query: 'x' },
    }, { clientId: 'preserved_client_00001' }), preserved)
    expect(await preservedResponse.json()).toEqual({
      error: 'The requested input is invalid.',
      code: 'invalid_action',
      sessionInvalidated: false,
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
