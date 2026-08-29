import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSessionCapability } from '../server/sessionCapability.ts'

interface RunningWorker {
  process: ReturnType<typeof spawn>
  directory: string
  socketPath: string
  capabilityToken: string
}

const workers: RunningWorker[] = []

async function startWorker(): Promise<RunningWorker> {
  const directory = await mkdtemp(join(tmpdir(), 'webmcp-worker-auth-'))
  const socketPath = join(directory, 'worker.sock')
  const configPath = join(directory, 'session.json')
  const capabilityToken = createSessionCapability()
  await writeFile(configPath, JSON.stringify({
    socketPath,
    capabilityToken,
    expiresAtMs: Date.now() + 60_000,
    target: {
      url: 'https://public.example.at/',
      origin: 'https://public.example.at',
      hostname: 'public.example.at',
      pinnedAddress: '93.184.216.34',
      addresses: [{ address: '93.184.216.34', family: 4 }],
    },
  }), { mode: 0o600 })
  const worker = spawn(process.execPath, [
    resolve('proof/sandbox/dist/worker.mjs'),
    configPath,
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise<void>((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker readiness timed out.')), 3_000)
    worker.once('error', reject)
    worker.stdout.once('data', (chunk) => {
      if (String(chunk).includes('READY')) {
        clearTimeout(timeout)
        resolveReady()
      }
    })
  })
  const running = { process: worker, directory, socketPath, capabilityToken }
  workers.push(running)
  return running
}

async function callWorker(
  worker: RunningWorker,
  capabilityToken: string,
  operation: string,
): Promise<{ status: number, body: string }> {
  const client = spawn(process.execPath, [resolve('proof/sandbox/client.mjs')], {
    env: {
      ...process.env,
      WEBMCP_WORKER_SOCKET: worker.socketPath,
      WEBMCP_SESSION_CAPABILITY: capabilityToken,
      WEBMCP_WORKER_OPERATION: operation,
      WEBMCP_WORKER_PAYLOAD: '{}',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  client.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)))
  client.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)))
  const exitCode = await new Promise<number | null>((resolveExit) => client.once('exit', resolveExit))
  if (exitCode !== 0) throw new Error(Buffer.concat(stderr).toString('utf8'))
  return JSON.parse(Buffer.concat(stdout).toString('utf8')) as { status: number, body: string }
}

afterEach(async () => {
  await Promise.all(workers.splice(0).map(async (worker) => {
    worker.process.kill('SIGTERM')
    await new Promise((resolveExit) => worker.process.once('exit', resolveExit))
    await rm(worker.directory, { recursive: true, force: true })
  }))
})

describe('sandbox worker capability boundary', () => {
  it('rejects a foreign token before analysis and leaves the browser service uninitialized', async () => {
    const worker = await startWorker()
    const unauthorized = await callWorker(worker, createSessionCapability(), 'analyze')
    expect(unauthorized.status).toBe(401)

    const health = await callWorker(worker, worker.capabilityToken, 'health')
    expect(health.status).toBe(200)
    expect(JSON.parse(health.body)).toEqual({ ready: true, analyzed: false })
  })
})

