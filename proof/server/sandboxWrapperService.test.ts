import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WrapperActionResult, WrapperAnalysis } from '../../src/features/wrapper/types.ts'
import type { PublicTarget } from './publicTarget.ts'
import { createSandboxLocator, createSessionCapability } from './sessionCapability.ts'
import {
  buildSandboxNetworkPolicy,
  SANDBOX_DENIED_CIDRS,
  SandboxWrapperService,
  type SandboxFactory,
} from './sandboxWrapperService.ts'
import { WRAPPER_SESSION_TTL_MS } from './wrapperLimits.ts'
import { WrapperServiceError } from './wrapperErrors.ts'

function analysisFixture(runtimeMs = 20): WrapperAnalysis {
  return {
    sessionId: 'internal-session',
    sessionToken: 'internal-token',
    requestedUrl: 'https://public.example.at/',
    finalUrl: 'https://public.example.at/',
    title: 'Fixture',
    screenshotDataUrl: 'data:image/jpeg;base64,AA==',
    domEvidence: [],
    axEvidence: [],
    capabilities: [],
    warnings: [],
    blockedRequests: 0,
    analyzedPages: 1,
    maxPages: 10,
    expiresAt: '2026-08-30T10:05:00.000Z',
    runtime: {
      provider: 'local-playwright',
      runtimeMs,
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
}

function actionFixture(runtimeMs = 20): WrapperActionResult {
  const analysis = analysisFixture(runtimeMs)
  return {
    finalUrl: analysis.finalUrl,
    analysis,
    activity: {
      id: 'activity-1',
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
}

class FakeSandbox {
  name = ''
  expectedToken = ''
  outerExpiresAtMs = 0
  deleted = 0
  commandCalls = 0
  forceStatus?: number
  forceError?: { status: number, code: string, error: string, sessionInvalidated?: boolean }
  delayAction = false
  getGate?: Promise<void>
  actionCommandGate?: Promise<void>
  actionOutputGate?: Promise<void>
  deleteGate?: Promise<void>
  legacyActionScreenshot = false
  afterAnalyzeResult?: () => void
  commandError?: Error
  totalDurationMs: number | undefined = 1_000
  workerRuntimeMs = 20
  totalActiveCpuDurationMs: number | undefined = 100
  totalIngressBytes = 2_000
  totalEgressBytes = 1_000

  async writeFiles(files: Array<{ path: string, content: string | Uint8Array }>) {
    const config = files.find(({ path }) => path.endsWith('session.json'))
    if (!config) throw new Error('Missing worker config.')
    const parsed = JSON.parse(String(config.content)) as { capabilityToken: string, expiresAtMs: number }
    this.expectedToken = parsed.capabilityToken
    this.outerExpiresAtMs = parsed.expiresAtMs
  }

  async runCommand(params: {
    env?: Record<string, string>
    detached?: boolean
    signal?: AbortSignal
  }) {
    this.commandCalls += 1
    if (params.detached) return commandResult(0, '')
    if (this.commandError) throw this.commandError
    const operation = params.env?.WEBMCP_WORKER_OPERATION
    const token = params.env?.WEBMCP_SESSION_CAPABILITY
    if (operation === 'action' && this.actionCommandGate) await this.actionCommandGate
    if (operation === 'action' && this.delayAction) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 80)
        params.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    }
    const status = token === this.expectedToken ? (this.forceError?.status ?? this.forceStatus ?? 200) : 401
    const body = this.forceError && token === this.expectedToken
      ? {
          error: this.forceError.error,
          code: this.forceError.code,
          sessionInvalidated: this.forceError.sessionInvalidated,
        }
      : status === 200
      ? operation === 'analyze'
        ? analysisFixture(this.workerRuntimeMs)
        : operation === 'action'
          ? (() => {
              const result = actionFixture(this.workerRuntimeMs)
              if (this.legacyActionScreenshot) {
                ;(result as WrapperActionResult & { screenshotDataUrl?: string }).screenshotDataUrl = result.analysis.screenshotDataUrl
              }
              return { result, outerExpiresAtMs: this.outerExpiresAtMs }
            })()
          : { ready: true, closed: true }
      : status === 410
        ? { error: 'The isolated browser session expired.', code: 'session_expired' }
        : { error: 'Invalid session capability.', code: 'invalid_capability', sessionInvalidated: false }
    if (status === 200 && operation === 'analyze') this.afterAnalyzeResult?.()
    const output = JSON.stringify({ status, body: JSON.stringify(body) })
    return commandResult(0, operation === 'action' && this.actionOutputGate
      ? async () => { await this.actionOutputGate; return output }
      : output)
  }

  async delete() {
    this.deleted += 1
    if (this.deleteGate) await this.deleteGate
  }
}

function commandResult(exitCode: number, output: string | (() => Promise<string>)) {
  return {
    exitCode,
    stdout: typeof output === 'function' ? output : async () => output,
    stderr: async () => '',
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function testTarget(): PublicTarget {
  return {
    url: 'https://public.example.at/',
    origin: 'https://public.example.at',
    hostname: 'public.example.at',
    pinnedAddress: '93.184.216.34',
    addresses: [{ address: '93.184.216.34', family: 4 }],
  }
}

function createHarness(
  browserSource: { snapshotId?: string, image?: string } = { snapshotId: 'snap_reviewed' },
  serviceOptions: {
    actionTimeoutMs?: number
    beforeActionReturn?: () => void | Promise<void>
  } = {},
) {
  const sandbox = new FakeSandbox()
  let createCalls = 0
  let getCalls = 0
  let lastCreateParams: Record<string, unknown> | undefined
  const factory: SandboxFactory = {
    async create(params) {
      createCalls += 1
      lastCreateParams = params
      sandbox.name = String(params.name)
      return sandbox
    },
    async get({ name }) {
      getCalls += 1
      if (sandbox.getGate) await sandbox.getGate
      if (name !== sandbox.name) {
        throw new WrapperServiceError(
          'session_expired',
          'The isolated browser session expired. Analyze the site again.',
          410,
        )
      }
      return sandbox
    },
  }
  const service = new SandboxWrapperService({
    factory,
    ...browserSource,
    resolveTarget: async () => testTarget(),
    loadWorkerAssets: async () => ({ worker: Buffer.from('worker'), client: Buffer.from('client') }),
    now: () => Date.parse('2026-08-30T10:00:00.000Z'),
    ...serviceOptions,
  })
  return {
    sandbox,
    service,
    counts: () => ({ createCalls, getCalls }),
    createParams: () => lastCreateParams,
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('SandboxWrapperService session boundaries', () => {
  it('enforces one absolute analysis deadline across DNS, create, and post-create setup', async () => {
    const dns = deferred<PublicTarget>()
    let dnsCreateCalls = 0
    const dnsService = new SandboxWrapperService({
      snapshotId: 'snap_reviewed',
      analysisTimeoutMs: 15,
      resolveTarget: () => dns.promise,
      factory: {
        async create() { dnsCreateCalls += 1; throw new Error('must not create') },
        async get() { throw new Error('must not reconnect') },
      },
      loadWorkerAssets: async () => ({ worker: Buffer.from('worker'), client: Buffer.from('client') }),
    })
    await expect(dnsService.analyze('https://public.example.at')).rejects.toMatchObject({
      code: 'analysis_timeout',
      status: 504,
    })
    expect(dnsCreateCalls).toBe(0)

    const lateCreate = deferred<FakeSandbox>()
    const lateSandbox = new FakeSandbox()
    const createService = new SandboxWrapperService({
      snapshotId: 'snap_reviewed',
      analysisTimeoutMs: 15,
      resolveTarget: async () => testTarget(),
      factory: {
        create: () => lateCreate.promise,
        async get() { throw new Error('must not reconnect') },
      },
      loadWorkerAssets: async () => ({ worker: Buffer.from('worker'), client: Buffer.from('client') }),
    })
    const creating = createService.analyze('https://public.example.at')
    await expect(creating).rejects.toMatchObject({ code: 'analysis_timeout', status: 504 })
    lateCreate.resolve(lateSandbox)
    await vi.waitFor(() => expect(lateSandbox.deleted).toBe(1))

    const setupSandbox = new FakeSandbox()
    setupSandbox.runCommand = async (params) => {
      if (params.detached) await new Promise(() => undefined)
      return commandResult(0, '')
    }
    const setupService = new SandboxWrapperService({
      snapshotId: 'snap_reviewed',
      analysisTimeoutMs: 15,
      resolveTarget: async () => testTarget(),
      factory: {
        async create() { return setupSandbox },
        async get() { throw new Error('must not reconnect') },
      },
      loadWorkerAssets: async () => ({ worker: Buffer.from('worker'), client: Buffer.from('client') }),
    })
    await expect(setupService.analyze('https://public.example.at')).rejects.toMatchObject({
      code: 'analysis_timeout',
      status: 504,
    })
    expect(setupSandbox.deleted).toBe(1)
  })

  it('trims option browser sources and treats whitespace-only values as unconfigured', async () => {
    const configured = createHarness({ snapshotId: '  snap_reviewed  ' })
    await configured.service.analyze('https://public.example.at')
    expect(configured.createParams()).toMatchObject({
      source: { type: 'snapshot', snapshotId: 'snap_reviewed' },
    })

    const image = createHarness({ snapshotId: '  ', image: '  docker.io/reviewed/browser:1  ' })
    await image.service.analyze('https://public.example.at')
    expect(image.createParams()).toMatchObject({ image: 'docker.io/reviewed/browser:1' })

    const missing = createHarness({ snapshotId: '  ', image: '\t' })
    await expect(missing.service.analyze('https://public.example.at')).rejects.toMatchObject({
      code: 'sandbox_not_configured',
      status: 503,
    })
    expect(missing.counts().createCalls).toBe(0)
  })

  it('trims environment browser-source fallbacks before provider use', async () => {
    vi.stubEnv('WEBMCP_SANDBOX_SNAPSHOT_ID', '  env_snapshot  ')
    vi.stubEnv('WEBMCP_SANDBOX_IMAGE', '  ')
    const environment = createHarness({})
    await environment.service.analyze('https://public.example.at')
    expect(environment.createParams()).toMatchObject({
      source: { type: 'snapshot', snapshotId: 'env_snapshot' },
    })

    vi.stubEnv('WEBMCP_SANDBOX_SNAPSHOT_ID', '  ')
    vi.stubEnv('WEBMCP_SANDBOX_IMAGE', '  docker.io/reviewed/env-browser:1  ')
    const environmentImage = createHarness({})
    await environmentImage.service.analyze('https://public.example.at')
    expect(environmentImage.createParams()).toMatchObject({
      image: 'docker.io/reviewed/env-browser:1',
    })
  })

  it('creates a random locator plus a separate capability and reconnects only through get', async () => {
    const harness = createHarness()
    const analysis = await harness.service.analyze('https://public.example.at')

    expect(analysis.sessionId).toMatch(/^webmcp-wrapper-[a-z0-9_-]{24}$/)
    expect(analysis.sessionToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(analysis.sessionToken).not.toContain(analysis.sessionId)
    expect(analysis.runtime).toMatchObject({
      provider: 'vercel-sandbox',
      vcpus: 2,
      memoryMb: 4096,
      ingressBytes: 2_000,
      egressBytes: 1_000,
    })
    expect(Date.parse(analysis.expiresAt) - Date.parse('2026-08-30T10:00:00.000Z')).toBe(WRAPPER_SESSION_TTL_MS)

    await harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'heat pump' },
    )
    expect(harness.counts()).toEqual({ createCalls: 1, getCalls: 1 })
  })

  it('lets missing, malformed, or foreign capabilities cause no browser or stop effect', async () => {
    const harness = createHarness()
    const analysis = await harness.service.analyze('https://public.example.at')
    const commandsBefore = harness.sandbox.commandCalls

    await expect(harness.service.execute(
      analysis.sessionId,
      '',
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toThrow('capability is invalid')
    expect(harness.counts().getCalls).toBe(0)
    expect(harness.sandbox.commandCalls).toBe(commandsBefore)

    const foreignToken = createSessionCapability()
    await expect(harness.service.execute(
      analysis.sessionId,
      foreignToken,
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toThrow('Invalid session capability')
    expect(await harness.service.closeSession(analysis.sessionId, foreignToken)).toBe(false)
    expect(harness.sandbox.deleted).toBe(0)
  })

  it('fails closed for an unknown locator and never creates a replacement sandbox', async () => {
    const harness = createHarness()
    const unknown = createSandboxLocator()
    await expect(harness.service.execute(
      unknown,
      createSessionCapability(),
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toThrow('session expired')
    expect(harness.counts()).toEqual({ createCalls: 0, getCalls: 1 })
  })

  it('deletes an expired session and deletes a valid session only after authorized close', async () => {
    const expired = createHarness()
    const expiredAnalysis = await expired.service.analyze('https://public.example.at')
    expired.sandbox.forceStatus = 410
    await expect(expired.service.execute(
      expiredAnalysis.sessionId,
      expiredAnalysis.sessionToken,
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toThrow('expired')
    expect(expired.sandbox.deleted).toBe(1)

    const valid = createHarness()
    const validAnalysis = await valid.service.analyze('https://public.example.at')
    expect(await valid.service.closeSession(validAnalysis.sessionId, validAnalysis.sessionToken)).toBe(true)
    expect(valid.sandbox.deleted).toBe(1)
  })

  it.each([
    ['invalid_action', 400, 'The requested input is invalid.'],
    ['page_limit', 422, 'This session reached its page limit.'],
  ])('preserves the sandbox after the pre-action %s rejection', async (code, status, message) => {
    const harness = createHarness()
    const analysis = await harness.service.analyze('https://public.example.at')
    harness.sandbox.forceError = { code, status, error: message, sessionInvalidated: false }

    await expect(harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({ code, status })
    expect(harness.sandbox.deleted).toBe(0)

    harness.sandbox.forceError = undefined
    await expect(harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'still usable' },
    )).resolves.toMatchObject({ structuredContent: { targetStateVerified: true } })
    expect(harness.sandbox.deleted).toBe(0)
  })

  it('deletes the sandbox when a public invalid_action follows a begun mutation', async () => {
    const harness = createHarness()
    const analysis = await harness.service.analyze('https://public.example.at')
    harness.sandbox.forceError = {
      code: 'invalid_action',
      status: 409,
      error: 'The page did not retain the requested value.',
      sessionInvalidated: true,
    }

    await expect(harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({
      code: 'invalid_action',
      sessionInvalidated: true,
    })
    expect(harness.sandbox.deleted).toBe(1)
  })

  it('marks every deleted action sandbox invalid even for capacity and unknown command failures', async () => {
    const capacity = createHarness()
    const capacityAnalysis = await capacity.service.analyze('https://public.example.at')
    capacity.sandbox.forceError = {
      code: 'sandbox_capacity',
      status: 503,
      error: 'Capacity is unavailable.',
    }
    await expect(capacity.service.execute(
      capacityAnalysis.sessionId,
      capacityAnalysis.sessionToken,
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({
      code: 'sandbox_capacity',
      sessionInvalidated: true,
    })
    expect(capacity.sandbox.deleted).toBe(1)

    const unknown = createHarness()
    const unknownAnalysis = await unknown.service.analyze('https://public.example.at')
    unknown.sandbox.commandError = new Error('provider secret at /opt/sandbox')
    await expect(unknown.service.execute(
      unknownAnalysis.sessionId,
      unknownAnalysis.sessionToken,
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({
      code: 'action_failed',
      message: 'The isolated browser operation failed.',
      sessionInvalidated: true,
    })
    expect(unknown.sandbox.deleted).toBe(1)
  })

  it('keeps cumulative worker runtime and cost monotonic when reconnect metrics are stale or absent', async () => {
    const harness = createHarness()
    harness.sandbox.legacyActionScreenshot = true
    harness.sandbox.totalDurationMs = 500
    harness.sandbox.totalActiveCpuDurationMs = undefined
    harness.sandbox.workerRuntimeMs = 1_200
    const analysis = await harness.service.analyze('https://public.example.at')
    expect(analysis.runtime.runtimeMs).toBe(1_200)

    harness.sandbox.totalDurationMs = undefined
    harness.sandbox.workerRuntimeMs = 2_500
    const first = await harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'first' },
    )
    harness.sandbox.workerRuntimeMs = 4_200
    const second = await harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'second' },
    )

    expect([analysis.runtime.runtimeMs, first.analysis.runtime.runtimeMs, second.analysis.runtime.runtimeMs])
      .toEqual([1_200, 2_500, 4_200])
    expect(first).not.toHaveProperty('screenshotDataUrl')
    expect(first.analysis.screenshotDataUrl).toBe('data:image/jpeg;base64,AA==')
    expect(second.analysis.runtime.estimatedCost.lowerBound)
      .toBeGreaterThanOrEqual(first.analysis.runtime.estimatedCost.lowerBound)
    expect(second.analysis.runtime.estimatedCost.upperBound)
      .toBeGreaterThanOrEqual(first.analysis.runtime.estimatedCost.upperBound)
  })

  it('never decorates an action past the outer Sandbox lifetime', async () => {
    const harness = createHarness()
    const analysis = await harness.service.analyze('https://public.example.at')
    const outerExpiry = Date.parse(analysis.expiresAt)
    harness.sandbox.workerRuntimeMs = 60_000
    const originalRunCommand = harness.sandbox.runCommand.bind(harness.sandbox)
    harness.sandbox.runCommand = async (params) => {
      const command = await originalRunCommand(params)
      if (params.env?.WEBMCP_WORKER_OPERATION !== 'action') return command
      const payload = JSON.parse(await command.stdout()) as { status: number, body: string }
      if (payload.status !== 200) return command
      const envelope = JSON.parse(payload.body) as {
        result: WrapperActionResult
        outerExpiresAtMs: number
      }
      envelope.result.analysis.expiresAt = new Date(outerExpiry + WRAPPER_SESSION_TTL_MS).toISOString()
      return commandResult(0, JSON.stringify({ ...payload, body: JSON.stringify(envelope) }))
    }

    const result = await harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'bounded lifetime' },
    )

    expect(Date.parse(result.analysis.expiresAt)).toBe(outerExpiry)
    expect(Date.parse(result.analysis.expiresAt)).toBeLessThanOrEqual(harness.sandbox.outerExpiresAtMs)
    harness.sandbox.forceStatus = 410
    await expect(harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'must not appear valid' },
    )).rejects.toMatchObject({ code: 'session_expired' })
  })

  it('enforces one absolute action deadline across reconnect, command, output, and return', async () => {
    const reconnect = createHarness(
      { snapshotId: 'snap_reviewed' },
      { actionTimeoutMs: 25 },
    )
    const reconnectAnalysis = await reconnect.service.analyze('https://public.example.at')
    const reconnectGate = deferred<void>()
    reconnect.sandbox.getGate = reconnectGate.promise
    await expect(reconnect.service.execute(
      reconnectAnalysis.sessionId,
      reconnectAnalysis.sessionToken,
      'prepare_page_search',
      { query: 'must time out while reconnecting' },
    )).rejects.toMatchObject({
      code: 'action_timeout',
      status: 504,
      sessionInvalidated: true,
      message: 'The isolated browser action exceeded its fixed time limit.',
    })
    expect(reconnect.sandbox.deleted).toBe(0)
    reconnectGate.resolve()
    await vi.waitFor(() => expect(reconnect.sandbox.deleted).toBe(1))

    const command = createHarness(
      { snapshotId: 'snap_reviewed' },
      { actionTimeoutMs: 25 },
    )
    const commandAnalysis = await command.service.analyze('https://public.example.at')
    const commandGate = deferred<void>()
    command.sandbox.actionCommandGate = commandGate.promise
    await expect(command.service.execute(
      commandAnalysis.sessionId,
      commandAnalysis.sessionToken,
      'prepare_page_search',
      { query: 'must time out in command' },
    )).rejects.toMatchObject({ code: 'action_timeout', sessionInvalidated: true })
    expect(command.sandbox.deleted).toBe(1)
    commandGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(command.sandbox.deleted).toBe(1)

    const output = createHarness(
      { snapshotId: 'snap_reviewed' },
      { actionTimeoutMs: 25 },
    )
    const outputAnalysis = await output.service.analyze('https://public.example.at')
    const outputGate = deferred<void>()
    output.sandbox.actionOutputGate = outputGate.promise
    await expect(output.service.execute(
      outputAnalysis.sessionId,
      outputAnalysis.sessionToken,
      'prepare_page_search',
      { query: 'must time out reading output' },
    )).rejects.toMatchObject({ code: 'action_timeout', sessionInvalidated: true })
    expect(output.sandbox.deleted).toBe(1)
    outputGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(output.sandbox.deleted).toBe(1)

    const returnGate = deferred<void>()
    const beforeReturn = vi.fn(() => returnGate.promise)
    const postResult = createHarness(
      { snapshotId: 'snap_reviewed' },
      { actionTimeoutMs: 25, beforeActionReturn: beforeReturn },
    )
    const postResultAnalysis = await postResult.service.analyze('https://public.example.at')
    await expect(postResult.service.execute(
      postResultAnalysis.sessionId,
      postResultAnalysis.sessionToken,
      'prepare_page_search',
      { query: 'must not return activity or credentials' },
    )).rejects.toMatchObject({ code: 'action_timeout', sessionInvalidated: true })
    expect(beforeReturn).toHaveBeenCalledOnce()
    expect(postResult.sandbox.deleted).toBe(1)
    returnGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(postResult.sandbox.deleted).toBe(1)

    const cleanup = createHarness(
      { snapshotId: 'snap_reviewed' },
      { actionTimeoutMs: 25 },
    )
    const cleanupAnalysis = await cleanup.service.analyze('https://public.example.at')
    const cleanupGate = deferred<void>()
    cleanup.sandbox.commandError = new Error('unknown command failure')
    cleanup.sandbox.deleteGate = cleanupGate.promise
    await expect(cleanup.service.execute(
      cleanupAnalysis.sessionId,
      cleanupAnalysis.sessionToken,
      'prepare_page_search',
      { query: 'cleanup must share the deadline' },
    )).rejects.toMatchObject({ code: 'action_timeout', sessionInvalidated: true })
    expect(cleanup.sandbox.deleted).toBe(1)
    cleanupGate.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cleanup.sandbox.deleted).toBe(1)
  })

  it('propagates abort to the command and deletes the partially mutable sandbox', async () => {
    const harness = createHarness()
    const analysis = await harness.service.analyze('https://public.example.at')
    harness.sandbox.delayAction = true
    const controller = new AbortController()
    const pending = harness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'x' },
      controller.signal,
    )
    setTimeout(() => controller.abort(), 10)
    await expect(pending).rejects.toMatchObject({
      code: 'action_failed',
      status: 499,
      sessionInvalidated: true,
      message: 'The isolated browser action was cancelled.',
    })
    expect(harness.sandbox.deleted).toBe(1)
  })

  it('deletes the sandbox when analysis is aborted after the worker result', async () => {
    const harness = createHarness()
    const controller = new AbortController()
    harness.sandbox.afterAnalyzeResult = () => controller.abort()

    await expect(harness.service.analyze(
      'https://public.example.at',
      controller.signal,
    )).rejects.toMatchObject({ name: 'AbortError' })

    expect(harness.counts()).toEqual({ createCalls: 1, getCalls: 0 })
    expect(harness.sandbox.deleted).toBe(1)
  })

  it('does not treat an untyped provider status as a session capability failure', async () => {
    const actionHarness = createHarness()
    const analysis = await actionHarness.service.analyze('https://public.example.at')
    actionHarness.sandbox.commandError = Object.assign(new Error('provider auth failed'), { status: 401 })

    await expect(actionHarness.service.execute(
      analysis.sessionId,
      analysis.sessionToken,
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({
      code: 'action_failed',
      message: 'The isolated browser operation failed.',
      sessionInvalidated: true,
    })
    expect(actionHarness.sandbox.deleted).toBe(1)

    const closeHarness = createHarness()
    const closeAnalysis = await closeHarness.service.analyze('https://public.example.at')
    closeHarness.sandbox.commandError = Object.assign(new Error('provider auth failed'), { status: 401 })
    await expect(closeHarness.service.closeSession(
      closeAnalysis.sessionId,
      closeAnalysis.sessionToken,
    )).rejects.toThrow('provider auth failed')
    expect(closeHarness.sandbox.deleted).toBe(1)
  })
})

describe('SandboxWrapperService network policy', () => {
  it('allows only the exact target host for GET/HEAD and denies private, reserved, and NAT64 CIDRs', () => {
    const policy = buildSandboxNetworkPolicy(testTarget())
    expect(policy).toMatchObject({
      allow: {
        'public.example.at': [{ match: { method: ['GET', 'HEAD'] }, transform: [] }],
      },
    })
    expect((policy as { subnets?: { deny?: string[] } }).subnets?.deny).toEqual(expect.arrayContaining([
      '10.0.0.0/8',
      '127.0.0.0/8',
      '64:ff9b::/96',
      '64:ff9b:1::/48',
      'fc00::/7',
    ]))
    expect(SANDBOX_DENIED_CIDRS).not.toContain('2606:4700:4700::1111')
  })

  it.each([
    {
      label: 'IPv4',
      target: {
        url: 'https://93.184.216.34/',
        origin: 'https://93.184.216.34',
        hostname: '93.184.216.34',
        pinnedAddress: '93.184.216.34',
        addresses: [{ address: '93.184.216.34', family: 4 }],
      } satisfies PublicTarget,
    },
    {
      label: 'IPv6',
      target: {
        url: 'https://[2606:4700:4700::1111]/',
        origin: 'https://[2606:4700:4700::1111]',
        hostname: '2606:4700:4700::1111',
        pinnedAddress: '2606:4700:4700::1111',
        addresses: [{ address: '2606:4700:4700::1111', family: 6 }],
      } satisfies PublicTarget,
    },
  ])('rejects a public $label literal before creating a production Sandbox', async ({ target }) => {
    let createCalls = 0
    const factory: SandboxFactory = {
      async create() {
        createCalls += 1
        throw new Error('must not create')
      },
      async get() {
        throw new Error('must not reconnect')
      },
    }
    const service = new SandboxWrapperService({
      factory,
      snapshotId: 'snap_reviewed',
      resolveTarget: async () => target,
      loadWorkerAssets: async () => ({ worker: Buffer.from('worker'), client: Buffer.from('client') }),
    })

    await expect(service.analyze(target.url)).rejects.toMatchObject({
      code: 'invalid_target',
      status: 400,
    })
    expect(createCalls).toBe(0)
  })
})
