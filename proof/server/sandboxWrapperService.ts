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
  WRAPPER_MEMORY_MB,
  WRAPPER_SESSION_TTL_MS,
  WRAPPER_VCPUS,
} from './wrapperLimits.ts'
import {
  isPublicWrapperErrorCode,
  WrapperServiceError,
} from './wrapperErrors.ts'

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
}

interface WorkerResponse {
  status: number
  body: string
}

function sandboxConfigurationError(): WrapperServiceError {
  return new WrapperServiceError(
    'sandbox_not_configured',
    'The production browser worker is not configured. Set WEBMCP_SANDBOX_SNAPSHOT_ID to a reviewed Chromium snapshot before enabling live analysis.',
    503,
  )
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
    return {
      subnets: {
        allow: [target.pinnedAddress.includes(':') ? `${target.pinnedAddress}/128` : `${target.pinnedAddress}/32`],
        deny: [...SANDBOX_DENIED_CIDRS],
      },
    }
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

function sandboxCapacityError(): WrapperServiceError {
  return new WrapperServiceError(
    'sandbox_capacity',
    'The isolated browser capacity is temporarily unavailable.',
    503,
  )
}

function isNonMutatingActionRejection(error: unknown): boolean {
  return error instanceof WrapperServiceError
    && error.sessionInvalidated === false
    && ['invalid_action', 'invalid_capability', 'page_limit'].includes(error.code)
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

  constructor(options: SandboxWrapperServiceOptions = {}) {
    this.factory = options.factory ?? defaultFactory()
    this.resolveTarget = options.resolveTarget ?? resolvePublicTarget
    this.snapshotId = options.snapshotId ?? process.env.WEBMCP_SANDBOX_SNAPSHOT_ID
    this.image = options.image ?? process.env.WEBMCP_SANDBOX_IMAGE
    this.loadWorkerAssets = options.loadWorkerAssets ?? defaultLoadWorkerAssets
    this.now = options.now ?? Date.now
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
    if (!this.snapshotId && !this.image) throw sandboxConfigurationError()
    const target = await this.resolveTarget(value)
    const sessionId = createSandboxLocator()
    const sessionToken = createSessionCapability()
    const startedAtMs = this.now()
    const expiresAtMs = startedAtMs + WRAPPER_SESSION_TTL_MS
    const assets = await this.loadWorkerAssets()
    let sandbox: SandboxHandle | undefined
    try {
      const source = this.snapshotId
        ? { type: 'snapshot', snapshotId: this.snapshotId }
        : undefined
      sandbox = await this.factory.create({
        name: sessionId,
        ...(source ? { source } : { image: this.image }),
        persistent: false,
        timeout: WRAPPER_SESSION_TTL_MS,
        resources: { vcpus: WRAPPER_VCPUS },
        networkPolicy: buildSandboxNetworkPolicy(target),
        signal,
        tags: { purpose: 'webmcp-wrapper', session: randomUUID().slice(0, 8) },
      })
      await sandbox.writeFiles([
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
      ], { signal })
      await sandbox.runCommand({
        cmd: 'node',
        args: [WORKER_PATH, CONFIG_PATH],
        detached: true,
        signal,
        timeoutMs: WRAPPER_SESSION_TTL_MS - 5_000,
      })

      let ready = false
      for (let attempt = 0; attempt < 20; attempt += 1) {
        try {
          await this.callWorker(sandbox, sessionToken, 'health', {}, signal)
          ready = true
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }
      if (!ready) throw new Error('The isolated Chromium worker did not become ready.')
      const analysis = await this.callWorker<WrapperAnalysis>(sandbox, sessionToken, 'analyze', {}, signal)
      return decorateAnalysis(analysis, sandbox, sessionId, sessionToken, expiresAtMs, startedAtMs, this.now)
    } catch (error) {
      await sandbox?.delete({ deleteOrphanSnapshots: true }).catch(() => undefined)
      if (signal?.aborted) throw new DOMException('The isolated analysis was cancelled.', 'AbortError')
      if (isSandboxCapacityError(error)) throw sandboxCapacityError()
      throw error
    }
  }

  async execute(
    sessionId: string,
    sessionToken: string,
    toolName: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<WrapperActionResult> {
    const sandbox = await this.getExisting(sessionId, sessionToken, signal)
    const startedAtMs = this.now()
    try {
      const result = await this.callWorker<WrapperActionResult>(
        sandbox,
        sessionToken,
        'action',
        { toolName, input },
        signal,
      )
      const expiresAtMs = Date.parse(result.analysis.expiresAt)
      const analysis = decorateAnalysis(
        result.analysis,
        sandbox,
        sessionId,
        sessionToken,
        Number.isFinite(expiresAtMs) ? expiresAtMs : startedAtMs + WRAPPER_SESSION_TTL_MS,
        startedAtMs,
        this.now,
      )
      return { ...result, analysis, finalUrl: analysis.finalUrl, screenshotDataUrl: analysis.screenshotDataUrl }
    } catch (error) {
      if (!isNonMutatingActionRejection(error)) {
        await sandbox.delete({ deleteOrphanSnapshots: true }).catch(() => undefined)
      }
      if (signal?.aborted) throw new DOMException('The isolated tool call was cancelled.', 'AbortError')
      if (isSandboxCapacityError(error)) throw sandboxCapacityError()
      throw error
    }
  }

  async closeSession(sessionId: string, sessionToken: string, signal?: AbortSignal): Promise<boolean> {
    let sandbox: SandboxHandle | undefined
    try {
      sandbox = await this.getExisting(sessionId, sessionToken, signal)
      await this.callWorker(sandbox, sessionToken, 'close', {}, signal)
    } catch (error) {
      if (error instanceof WrapperServiceError && error.code === 'invalid_capability') return false
      if (error instanceof WrapperServiceError && error.code === 'session_expired') return false
      await sandbox?.delete({ deleteOrphanSnapshots: true }).catch(() => undefined)
      throw error
    }
    await sandbox.delete({ deleteOrphanSnapshots: true }).catch(() => undefined)
    return true
  }
}
