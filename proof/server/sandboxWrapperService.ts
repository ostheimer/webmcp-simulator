import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { APIError, type NetworkPolicy } from '@vercel/sandbox'
import type { WrapperActionResult, WrapperAnalysis } from '../../src/features/wrapper/types.ts'
import { resolvePublicTarget, type PublicTarget } from './publicTarget.ts'
import {
  createSandboxLocator,
  createSessionCapability,
  isSandboxLocator,
  isSessionCapability,
} from './sessionCapability.ts'
import {
  estimateWrapperCost,
  WRAPPER_ACTION_TIMEOUT_MS,
  WRAPPER_ANALYSIS_TIMEOUT_MS,
  WRAPPER_CLOSE_PROVIDER_CLEANUP_TIMEOUT_MS,
  WRAPPER_MEMORY_MB,
  WRAPPER_SESSION_TTL_MS,
  WRAPPER_VCPUS,
} from './wrapperLimits.ts'
import {
  isPublicWrapperErrorCode,
  WrapperServiceError,
} from './wrapperErrors.ts'

// Every command must name its working directory explicitly. A Sandbox restored
// from a snapshot does not carry the default working directory that an
// image-based Sandbox provides, so an implicit cwd fails with
// `chdir /vercel/sandbox: no such file or directory` before the command runs.
const WORKER_ROOT = '/opt/webmcp-wrapper'
const WORKER_PATH = `${WORKER_ROOT}/worker.mjs`
const CLIENT_PATH = `${WORKER_ROOT}/client.mjs`
const CONFIG_PATH = `${WORKER_ROOT}/session.json`
const SOCKET_PATH = '/tmp/webmcp-wrapper.sock'

export const SANDBOX_DENIED_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
  '::/128',
  '::1/128',
  '::ffff:0:0/96',
  '64:ff9b::/96',
  '64:ff9b:1::/48',
  '100::/64',
  '2001::/23',
  '2002::/16',
  '3fff::/20',
  'fc00::/7',
  'fe80::/10',
  'ff00::/8',
] as const

interface SandboxCommandResult {
  exitCode: number | null
  stdout(): Promise<string>
  stderr(): Promise<string>
}

interface SandboxHandle {
  name: string
  totalEgressBytes?: number
  totalIngressBytes?: number
  totalActiveCpuDurationMs?: number
  totalDurationMs?: number
  writeFiles(files: Array<{ path: string, content: string | Uint8Array, mode?: number }>, options?: { signal?: AbortSignal }): Promise<void>
  runCommand(params: {
    cmd: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
    detached?: boolean
    signal?: AbortSignal
    timeoutMs?: number
  }): Promise<SandboxCommandResult>
  delete(options?: { deleteOrphanSnapshots?: boolean, signal?: AbortSignal }): Promise<void>
}

export interface SandboxFactory {
  create(params: Record<string, unknown>): Promise<SandboxHandle>
  get(params: { name: string, resume: false, signal?: AbortSignal }): Promise<SandboxHandle>
}

export interface SandboxWrapperServiceOptions {
  factory?: SandboxFactory
  resolveTarget?: (value: string) => Promise<PublicTarget>
  snapshotId?: string
  image?: string
  loadWorkerAssets?: () => Promise<{ worker: Buffer, client: Buffer }>
  now?: () => number
  /** Test-only override; production uses the absolute configured analysis deadline. */
  analysisTimeoutMs?: number
  /** Test-only override; production uses the absolute configured action deadline. */
  actionTimeoutMs?: number
  /** Test-only override for request-independent provider cleanup after close cancellation. */
  closeCleanupTimeoutMs?: number
  /** Test-only boundary hook for the post-decoration/pre-return deadline race. */
  beforeActionReturn?: () => void | Promise<void>
}

interface WorkerResponse {
  status: number
  body: string
}

interface WorkerActionEnvelope {
  result: WrapperActionResult
  outerExpiresAtMs: number
}

function sandboxConfigurationError(): WrapperServiceError {
  return new WrapperServiceError(
    'sandbox_not_configured',
    'The production browser worker is not configured. Set WEBMCP_SANDBOX_SNAPSHOT_ID to a reviewed Chromium snapshot before enabling live analysis.',
    503,
  )
}

function normalizedBrowserSource(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized || undefined
}

function defaultFactory(): SandboxFactory {
  return {
    async create(params) {
      const { Sandbox } = await import('@vercel/sandbox')
      return Sandbox.create(params as Parameters<typeof Sandbox.create>[0]) as Promise<SandboxHandle>
    },
    async get(params) {
      const { Sandbox } = await import('@vercel/sandbox')
      return Sandbox.get(params) as Promise<SandboxHandle>
    },
  }
}

async function defaultLoadWorkerAssets(): Promise<{ worker: Buffer, client: Buffer }> {
  const [worker, client] = await Promise.all([
    readFile(new URL('../sandbox/dist/worker.mjs', import.meta.url)),
    readFile(new URL('../sandbox/client.mjs', import.meta.url)),
  ])
  return { worker, client }
}

export function buildSandboxNetworkPolicy(target: PublicTarget): NetworkPolicy {
  const match = [{ match: { method: ['GET', 'HEAD'] }, transform: [] }]
  if (isIP(target.hostname)) {
    throw new WrapperServiceError(
      'invalid_target',
      'IP-literal website targets are not supported by the production browser worker.',
      400,
    )
  }
  return {
    allow: { [target.hostname]: match },
    subnets: { deny: [...SANDBOX_DENIED_CIDRS] },
  }
}

function parseWorkerResponse<T>(output: string): T {
  let envelope: WorkerResponse
  let body: T & { error?: string, code?: unknown, sessionInvalidated?: unknown }
  try {
    envelope = JSON.parse(output) as WorkerResponse
    body = JSON.parse(envelope.body) as T & { error?: string, code?: unknown }
  } catch {
    throw new Error('The isolated worker returned an invalid response envelope.')
  }
  if (envelope.status < 200 || envelope.status >= 300) {
    if (isPublicWrapperErrorCode(body.code)) {
      throw new WrapperServiceError(
        body.code,
        body.error || 'The isolated browser operation failed.',
        envelope.status,
        {
          sessionInvalidated: typeof body.sessionInvalidated === 'boolean'
            ? body.sessionInvalidated
            : undefined,
        },
      )
    }
    throw new Error('The isolated worker failed without a recognized public error code.')
  }
  return body
}

function isSandboxCapacityError(error: unknown): boolean {
  return error instanceof APIError && [402, 429, 503].includes(error.response.status)
}

function isSandboxUnavailableError(error: unknown): boolean {
  return error instanceof APIError && [404, 410].includes(error.response.status)
}

function sandboxCapacityError(sessionInvalidated?: boolean): WrapperServiceError {
  return new WrapperServiceError(
    'sandbox_capacity',
    'The isolated browser capacity is temporarily unavailable.',
    503,
    { sessionInvalidated },
  )
}

function sandboxAnalysisTimeoutError(): WrapperServiceError {
  return new WrapperServiceError(
    'analysis_timeout',
    'The isolated website analysis exceeded its fixed time limit.',
    504,
  )
}

function sandboxAnalysisAbortError(): DOMException {
  return new DOMException('The isolated analysis was cancelled.', 'AbortError')
}

function sandboxActionTimeoutError(): WrapperServiceError {
  return new WrapperServiceError(
    'action_timeout',
    'The isolated browser action exceeded its fixed time limit.',
    504,
    { sessionInvalidated: true },
  )
}

function sandboxActionAbortError(): WrapperServiceError {
  return new WrapperServiceError(
    'action_failed',
    'The isolated browser action was cancelled.',
    499,
    { sessionInvalidated: true },
  )
}

async function raceSandboxOperation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined)
    throw sandboxAnalysisAbortError()
  }
  let rejectAbort!: (reason: DOMException) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(sandboxAnalysisAbortError())
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
    void promise.catch(() => undefined)
  }
}

function isNonMutatingActionRejection(error: unknown): boolean {
  return error instanceof WrapperServiceError
    && error.sessionInvalidated === false
    && ['invalid_action', 'invalid_capability', 'page_limit'].includes(error.code)
}

async function deleteClosedSandbox(
  sandbox: SandboxHandle,
  signal?: AbortSignal,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const deletion = sandbox.delete({ deleteOrphanSnapshots: true, signal })
      if (signal) await raceSandboxOperation(deletion, signal)
      else await deletion
      return
    } catch (error) {
      if (signal?.aborted) throw error
      if (attempt === 0) continue
    }
  }
  throw new WrapperServiceError(
    'action_failed',
    'The isolated browser session could not be closed.',
    503,
  )
}

async function deleteClosedSandboxWithin(
  sandbox: SandboxHandle,
  timeoutMs: number,
): Promise<void> {
  const cleanupController = new AbortController()
  const cleanupTimer = setTimeout(
    () => cleanupController.abort(),
    Math.max(0, timeoutMs),
  )
  cleanupTimer.unref?.()
  try {
    await deleteClosedSandbox(sandbox, cleanupController.signal)
  } finally {
    clearTimeout(cleanupTimer)
  }
}

function decorateAnalysis(
  analysis: WrapperAnalysis,
  sandbox: SandboxHandle,
  sessionId: string,
  sessionToken: string,
  expiresAtMs: number,
  startedAtMs: number,
  now: () => number,
): WrapperAnalysis {
  const runtimeMs = Math.max(
    0,
    sandbox.totalDurationMs ?? 0,
    analysis.runtime.runtimeMs,
    now() - startedAtMs,
  )
  const usage = {
    runtimeMs,
    activeCpuMs: sandbox.totalActiveCpuDurationMs,
    ingressBytes: sandbox.totalIngressBytes,
    egressBytes: sandbox.totalEgressBytes,
  }
  return {
    ...analysis,
    sessionId,
    sessionToken,
    expiresAt: new Date(expiresAtMs).toISOString(),
    runtime: {
      ...analysis.runtime,
      provider: 'vercel-sandbox',
      runtimeMs,
      vcpus: WRAPPER_VCPUS,
      memoryMb: WRAPPER_MEMORY_MB,
      ingressBytes: usage.ingressBytes,
      egressBytes: usage.egressBytes,
      estimatedCost: estimateWrapperCost(usage),
    },
  }
}

export class SandboxWrapperService {
  private readonly factory: SandboxFactory
  private readonly resolveTarget: (value: string) => Promise<PublicTarget>
  private readonly snapshotId?: string
  private readonly image?: string
  private readonly loadWorkerAssets: () => Promise<{ worker: Buffer, client: Buffer }>
  private readonly now: () => number
  private readonly analysisTimeoutMs: number
  private readonly actionTimeoutMs: number
  private readonly closeCleanupTimeoutMs: number
  private readonly beforeActionReturn?: () => void | Promise<void>

  constructor(options: SandboxWrapperServiceOptions = {}) {
    this.factory = options.factory ?? defaultFactory()
    this.resolveTarget = options.resolveTarget ?? resolvePublicTarget
    this.snapshotId = normalizedBrowserSource(
      options.snapshotId ?? process.env.WEBMCP_SANDBOX_SNAPSHOT_ID,
    )
    this.image = normalizedBrowserSource(
      options.image ?? process.env.WEBMCP_SANDBOX_IMAGE,
    )
    this.loadWorkerAssets = options.loadWorkerAssets ?? defaultLoadWorkerAssets
    this.now = options.now ?? Date.now
    this.analysisTimeoutMs = options.analysisTimeoutMs ?? WRAPPER_ANALYSIS_TIMEOUT_MS
    this.actionTimeoutMs = options.actionTimeoutMs ?? WRAPPER_ACTION_TIMEOUT_MS
    this.closeCleanupTimeoutMs = options.closeCleanupTimeoutMs ?? WRAPPER_CLOSE_PROVIDER_CLEANUP_TIMEOUT_MS
    this.beforeActionReturn = options.beforeActionReturn
  }

  private async callWorker<T>(
    sandbox: SandboxHandle,
    capabilityToken: string,
    operation: 'health' | 'analyze' | 'action' | 'close',
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const command = await sandbox.runCommand({
      cmd: 'node',
      args: [CLIENT_PATH],
      cwd: WORKER_ROOT,
      env: {
        WEBMCP_WORKER_SOCKET: SOCKET_PATH,
        WEBMCP_SESSION_CAPABILITY: capabilityToken,
        WEBMCP_WORKER_OPERATION: operation,
        WEBMCP_WORKER_PAYLOAD: JSON.stringify(payload),
      },
      signal,
      timeoutMs: operation === 'analyze' ? WRAPPER_ANALYSIS_TIMEOUT_MS : WRAPPER_ACTION_TIMEOUT_MS,
    })
    const [stdout, stderr] = await Promise.all([command.stdout(), command.stderr()])
    if (command.exitCode !== 0) {
      void stderr
      throw new Error('The sandbox command did not complete successfully.')
    }
    return parseWorkerResponse<T>(stdout)
  }

  private async getExisting(sessionId: string, sessionToken: string, signal?: AbortSignal): Promise<SandboxHandle> {
    if (!isSandboxLocator(sessionId) || !isSessionCapability(sessionToken)) {
      throw new WrapperServiceError(
        'invalid_capability',
        'The isolated browser session capability is invalid.',
        401,
      )
    }
    try {
      return await this.factory.get({ name: sessionId, resume: false, signal })
    } catch (error) {
      if (error instanceof WrapperServiceError && error.code === 'session_expired') throw error
      if (isSandboxCapacityError(error)) throw sandboxCapacityError()
      if (isSandboxUnavailableError(error)) {
        throw new WrapperServiceError(
          'session_expired',
          'The isolated browser session expired. Analyze the site again.',
          410,
        )
      }
      throw error
    }
  }

  async analyze(value: string, signal?: AbortSignal): Promise<WrapperAnalysis> {
    const startedAtMs = this.now()
    let deadlineExpired = false
    const operationController = new AbortController()
    const onExternalAbort = () => operationController.abort()
    signal?.addEventListener('abort', onExternalAbort, { once: true })
    if (signal?.aborted) operationController.abort()
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true
      operationController.abort()
    }, this.analysisTimeoutMs)
    deadlineTimer.unref?.()
    let sandbox: SandboxHandle | undefined
    const deleted = new WeakSet<object>()
    const deleteSandboxOnce = async (handle: SandboxHandle | undefined): Promise<void> => {
      if (!handle || deleted.has(handle)) return
      try {
        await deleteClosedSandbox(handle)
        deleted.add(handle)
      } catch {
        // Cleanup is best-effort here; preserve the original analysis failure.
      }
    }
    try {
      if (!this.snapshotId && !this.image) throw sandboxConfigurationError()
      const target = await raceSandboxOperation(
        this.resolveTarget(value),
        operationController.signal,
      )
      const sessionId = createSandboxLocator()
      const sessionToken = createSessionCapability()
      const expiresAtMs = startedAtMs + WRAPPER_SESSION_TTL_MS
      const assets = await raceSandboxOperation(
        this.loadWorkerAssets(),
        operationController.signal,
      )
      const source = this.snapshotId
        ? { type: 'snapshot', snapshotId: this.snapshotId }
        : undefined
      const createPromise = this.factory.create({
        name: sessionId,
        ...(source ? { source } : { image: this.image }),
        persistent: false,
        timeout: WRAPPER_SESSION_TTL_MS,
        resources: { vcpus: WRAPPER_VCPUS },
        networkPolicy: buildSandboxNetworkPolicy(target),
        signal: operationController.signal,
        tags: { purpose: 'webmcp-wrapper', session: randomUUID().slice(0, 8) },
      })
      try {
        sandbox = await raceSandboxOperation(createPromise, operationController.signal)
      } catch (error) {
        if (operationController.signal.aborted) {
          await createPromise.then(deleteSandboxOnce).catch(() => undefined)
        }
        throw error
      }
      await raceSandboxOperation(sandbox.writeFiles([
        { path: WORKER_PATH, content: assets.worker, mode: 0o700 },
        { path: CLIENT_PATH, content: assets.client, mode: 0o700 },
        {
          path: CONFIG_PATH,
          content: JSON.stringify({
            socketPath: SOCKET_PATH,
            capabilityToken: sessionToken,
            expiresAtMs,
            target,
          }),
          mode: 0o600,
        },
      ], { signal: operationController.signal }), operationController.signal)
      await raceSandboxOperation(sandbox.runCommand({
        cmd: 'node',
        args: [WORKER_PATH, CONFIG_PATH],
        cwd: WORKER_ROOT,
        detached: true,
        signal: operationController.signal,
        timeoutMs: WRAPPER_SESSION_TTL_MS - 5_000,
      }), operationController.signal)

      let ready = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await raceSandboxOperation(
            this.callWorker(sandbox, sessionToken, 'health', {}, operationController.signal),
            operationController.signal,
          )
          ready = true
          break
        } catch {
          if (operationController.signal.aborted) throw sandboxAnalysisAbortError()
          await raceSandboxOperation(
            new Promise((resolve) => setTimeout(resolve, 100)),
            operationController.signal,
          )
        }
      }
      if (!ready) throw new Error('The isolated Chromium worker did not become ready.')
      const analysis = await raceSandboxOperation(
        this.callWorker<WrapperAnalysis>(
          sandbox,
          sessionToken,
          'analyze',
          {},
          operationController.signal,
        ),
        operationController.signal,
      )
      if (operationController.signal.aborted) throw sandboxAnalysisAbortError()
      return decorateAnalysis(analysis, sandbox, sessionId, sessionToken, expiresAtMs, startedAtMs, this.now)
    } catch (error) {
      const timedOut = deadlineExpired
      await deleteSandboxOnce(sandbox)
      if (timedOut) throw sandboxAnalysisTimeoutError()
      if (signal?.aborted || operationController.signal.aborted) throw sandboxAnalysisAbortError()
      if (isSandboxCapacityError(error)) throw sandboxCapacityError()
      throw error
    } finally {
      clearTimeout(deadlineTimer)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  async execute(
    sessionId: string,
    sessionToken: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    capabilityId?: string,
  ): Promise<WrapperActionResult> {
    const startedAtMs = this.now()
    const deadlineAtMs = Date.now() + Math.max(0, this.actionTimeoutMs)
    let deadlineExpired = false
    const operationController = new AbortController()
    const onExternalAbort = () => operationController.abort()
    signal?.addEventListener('abort', onExternalAbort, { once: true })
    if (signal?.aborted) operationController.abort()
    const deadlineTimer = setTimeout(() => {
      deadlineExpired = true
      operationController.abort()
    }, Math.max(0, this.actionTimeoutMs))
    deadlineTimer.unref?.()
    const deadlineReached = () => deadlineExpired || Date.now() >= deadlineAtMs
    let sandbox: SandboxHandle | undefined
    let workerAuthenticated = false
    const deleted = new WeakSet<object>()
    const deleteSandboxOnce = async (handle: SandboxHandle | undefined): Promise<void> => {
      if (!handle || deleted.has(handle)) return
      try {
        await deleteClosedSandbox(handle)
        deleted.add(handle)
      } catch {
        // Cleanup is best-effort here; preserve the original action failure.
      }
    }
    try {
      const reconnectPromise = this.getExisting(
        sessionId,
        sessionToken,
        operationController.signal,
      )
      try {
        sandbox = await raceSandboxOperation(reconnectPromise, operationController.signal)
      } catch (error) {
        if (operationController.signal.aborted) {
          // A reconnect locator is not an authorization capability. Until the
          // worker has authenticated sessionToken, a late provider handle must
          // not be deleted on behalf of this untrusted caller.
          void reconnectPromise.catch(() => undefined)
        }
        throw error
      }
      const healthPromise = this.callWorker(
        sandbox,
        sessionToken,
        'health',
        {},
        operationController.signal,
      )
      try {
        await raceSandboxOperation(
          healthPromise,
          operationController.signal,
        )
        workerAuthenticated = true
      } catch (error) {
        if (error instanceof WrapperServiceError && error.code !== 'invalid_capability') {
          workerAuthenticated = true
        }
        if (operationController.signal.aborted) {
          void healthPromise.then(
            () => deleteClosedSandboxWithin(
              sandbox!,
              WRAPPER_CLOSE_PROVIDER_CLEANUP_TIMEOUT_MS,
            ),
            (lateError: unknown) => lateError instanceof WrapperServiceError
              && lateError.code !== 'invalid_capability'
              ? deleteClosedSandboxWithin(
                  sandbox!,
                  WRAPPER_CLOSE_PROVIDER_CLEANUP_TIMEOUT_MS,
                )
              : undefined,
          ).catch(() => undefined)
        }
        throw error
      }
      const workerResult = await raceSandboxOperation(
        this.callWorker<WorkerActionEnvelope>(
          sandbox,
          sessionToken,
          'action',
          { toolName, capabilityId, input },
          operationController.signal,
        ),
        operationController.signal,
      )
      if (deadlineReached()) {
        deadlineExpired = true
        operationController.abort()
        throw sandboxAnalysisAbortError()
      }
      if (
        !workerResult
        || typeof workerResult !== 'object'
        || !workerResult.result
        || !Number.isFinite(workerResult.outerExpiresAtMs)
      ) throw new Error('The isolated worker returned invalid session lifetime metadata.')
      const result = workerResult.result
      const innerExpiresAtMs = Date.parse(result.analysis.expiresAt)
      const expiresAtMs = Number.isFinite(innerExpiresAtMs)
        ? Math.min(innerExpiresAtMs, workerResult.outerExpiresAtMs)
        : workerResult.outerExpiresAtMs
      const analysis = decorateAnalysis(
        result.analysis,
        sandbox,
        sessionId,
        sessionToken,
        expiresAtMs,
        startedAtMs,
        this.now,
      )
      const response = {
        finalUrl: analysis.finalUrl,
        analysis,
        activity: result.activity,
        structuredContent: result.structuredContent,
      }
      if (this.beforeActionReturn) {
        await raceSandboxOperation(
          Promise.resolve(this.beforeActionReturn()),
          operationController.signal,
        )
      }
      if (deadlineReached()) {
        deadlineExpired = true
        operationController.abort()
        throw sandboxAnalysisAbortError()
      }
      if (this.now() >= expiresAtMs) {
        throw new WrapperServiceError(
          'session_expired',
          'The isolated browser session expired. Analyze the site again.',
          410,
          { sessionInvalidated: true },
        )
      }
      return response
    } catch (error) {
      let timedOut = deadlineReached()
      if (timedOut) {
        deadlineExpired = true
        operationController.abort()
      }
      let externallyAborted = signal?.aborted === true
      const selectedSessionExpiry = !timedOut
        && !externallyAborted
        && error instanceof WrapperServiceError
        && error.code === 'session_expired'
      const nonMutating = !timedOut
        && !externallyAborted
        && isNonMutatingActionRejection(error)
      if (!nonMutating && workerAuthenticated) {
        const cleanup = deleteSandboxOnce(sandbox)
        if (!operationController.signal.aborted) {
          await raceSandboxOperation(cleanup, operationController.signal).catch(() => undefined)
        }
      }
      if (selectedSessionExpiry) {
        throw new WrapperServiceError(error.code, error.message, error.status, {
          sessionInvalidated: true,
        })
      }
      timedOut = deadlineReached()
      externallyAborted = signal?.aborted === true
      if (timedOut) throw sandboxActionTimeoutError()
      if (externallyAborted || operationController.signal.aborted) throw sandboxActionAbortError()
      if (nonMutating) throw error
      if (isSandboxCapacityError(error)) throw sandboxCapacityError(true)
      if (error instanceof WrapperServiceError) {
        throw new WrapperServiceError(error.code, error.message, error.status, {
          sessionInvalidated: true,
        })
      }
      throw new WrapperServiceError(
        'action_failed',
        'The isolated browser operation failed.',
        500,
        { sessionInvalidated: true },
      )
    } finally {
      clearTimeout(deadlineTimer)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  async closeSession(sessionId: string, sessionToken: string, signal?: AbortSignal): Promise<boolean> {
    let sandbox: SandboxHandle | undefined
    let workerExpired = false
    try {
      sandbox = await this.getExisting(sessionId, sessionToken, signal)
      await this.callWorker(sandbox, sessionToken, 'close', {}, signal)
    } catch (error) {
      if (error instanceof WrapperServiceError && error.code === 'invalid_capability') return false
      if (error instanceof WrapperServiceError && error.code === 'session_expired') {
        if (!sandbox) return false
        workerExpired = true
        // The provider resource was reacquired and authorized even though its
        // inner worker lifetime has elapsed. Continue through the normal
        // idempotent provider deletion path instead of leaving that resource
        // allocated for the outer Sandbox lifetime.
      } else {
        if (sandbox) {
          // Reconnect/worker-close cancellation can happen after the authorized
          // worker has begun stopping. Provider cleanup must remain bounded and
          // independent of the abandoned request signal on this path as well.
          await deleteClosedSandboxWithin(sandbox, this.closeCleanupTimeoutMs).catch(() => undefined)
        }
        throw error
      }
    }
    if (!sandbox) return false
    if (workerExpired) {
      await deleteClosedSandboxWithin(sandbox, this.closeCleanupTimeoutMs)
      if (signal?.aborted) throw sandboxAnalysisAbortError()
      return true
    }
    try {
      await deleteClosedSandbox(sandbox, signal)
      return true
    } catch (error) {
      if (!signal?.aborted) throw error
      // The authorized worker is already closed. Provider deletion must no
      // longer depend on the abandoned HTTP request signal, otherwise the
      // sandbox can occupy capacity until its outer TTL. Vercel deletion is
      // idempotent, so a bounded independent retry is safe even if the first
      // signal-bound call completes late.
      await deleteClosedSandboxWithin(sandbox, this.closeCleanupTimeoutMs).catch(() => undefined)
      throw error
    }
  }
}
