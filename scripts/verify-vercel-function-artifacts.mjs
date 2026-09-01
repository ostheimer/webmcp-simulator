import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { access } from 'node:fs/promises'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const handlerContracts = [
  { name: 'analyze', method: 'GET', allowedMethod: 'POST', maxDuration: 60 },
  { name: 'action', method: 'GET', allowedMethod: 'POST', maxDuration: 30 },
  { name: 'session', method: 'GET', allowedMethod: 'DELETE', maxDuration: 15 },
  { name: 'health', method: 'GET' },
]
const artifacts = new Map()

async function findVercelNodeDevServer() {
  for (const binDirectory of (process.env.PATH ?? '').split(delimiter)) {
    if (!binDirectory) continue

    const vercelPackageRoot = resolve(binDirectory, '..', 'vercel')
    for (const candidate of [
      resolve(vercelPackageRoot, 'node_modules', '@vercel', 'node', 'dist', 'dev-server.mjs'),
      resolve(vercelPackageRoot, '..', '@vercel', 'node', 'dist', 'dev-server.mjs'),
    ]) {
      try {
        await access(candidate)
        return candidate
      } catch {
        // Try the other supported npm dependency layout and PATH entries.
      }
    }
  }

  throw new Error('Could not locate the @vercel/node development runtime from the Vercel CLI.')
}

async function stopRuntime(child) {
  if (child.exitCode !== null || child.signalCode !== null) return

  if (child.connected) child.send('shutdown', () => undefined)
  let shutdownTimer
  try {
    await Promise.race([
      new Promise(resolveExit => child.once('exit', resolveExit)),
      new Promise(resolveTimeout => {
        shutdownTimer = setTimeout(resolveTimeout, 500)
      }),
    ])
  } finally {
    clearTimeout(shutdownTimer)
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function requestThroughVercelRuntime(runtimePath, contract) {
  const functionRoot = resolve(
    repositoryRoot,
    '.vercel',
    'output',
    'functions',
    'api',
    'wrapper',
    `${contract.name}.func`,
  )
  const entrypoint = join('api', 'wrapper', `${contract.name}.js`)
  const child = fork(runtimePath, [], {
    cwd: functionRoot,
    execArgv: [],
    env: {
      ...process.env,
      VERCEL_DEV_ENTRYPOINT: entrypoint,
      VERCEL_DEV_CONFIG: JSON.stringify({ zeroConfig: true, helpers: true }),
      VERCEL_DEV_BUILD_ENV: '{}',
      VERCEL_DEV_PORT: '0',
    },
    silent: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
  })

  try {
    let startupTimer
    const address = await new Promise((resolveAddress, rejectAddress) => {
      startupTimer = setTimeout(
        () => rejectAddress(new Error(`Vercel runtime did not start in time. ${stderr}`)),
        8_000,
      )
      child.once('message', value => {
        clearTimeout(startupTimer)
        resolveAddress(value)
      })
      child.once('exit', code => {
        clearTimeout(startupTimer)
        rejectAddress(
          new Error(`Vercel runtime exited before listening (code ${code}). ${stderr}`),
        )
      })
    })

    return await fetch(`http://127.0.0.1:${address.port}/api/wrapper/${contract.name}`, {
      method: contract.method,
      signal: AbortSignal.timeout(3_000),
    })
  } catch (error) {
    throw new Error(
      `Vercel runtime did not emit the ${contract.name} response. ${stderr}`,
      { cause: error },
    )
  } finally {
    await stopRuntime(child)
  }
}

for (const contract of handlerContracts) {
  const artifactPath = resolve(
    repositoryRoot,
    '.vercel',
    'output',
    'functions',
    'api',
    'wrapper',
    `${contract.name}.func`,
    'api',
    'wrapper',
    `${contract.name}.js`,
  )

  await access(artifactPath)
  const artifact = await import(pathToFileURL(artifactPath).href)
  if (contract.maxDuration) assert.equal(artifact.maxDuration, contract.maxDuration)
  artifacts.set(contract.name, artifact)
}

const runtimePath = await findVercelNodeDevServer()
const healthResponse = await requestThroughVercelRuntime(runtimePath, handlerContracts[3])
for (const contract of handlerContracts) {
  assert.equal(
    typeof artifacts.get(contract.name)?.default?.fetch,
    'function',
    `Expected ${contract.name} artifact to export the Vercel default fetch handler`,
  )
}
const expectedReady = Boolean(
  process.env.WEBMCP_SANDBOX_SNAPSHOT_ID?.trim()
  || process.env.WEBMCP_SANDBOX_IMAGE?.trim(),
)

assert.ok(healthResponse instanceof Response, 'Expected health handler to return a Response')
assert.equal(healthResponse.status, 200, 'Expected health artifact to answer liveness checks')
assert.deepEqual(await healthResponse.json(), {
  alive: true,
  ready: expectedReady,
  mode: 'vercel-sandbox',
  configuration: expectedReady ? 'configured' : 'missing-browser-source',
  persistence: false,
  sessionTtlSeconds: 300,
  maxPages: 10,
})

const methodGuardContracts = [
  ...handlerContracts.slice(0, 3),
  { name: 'health', method: 'POST', allowedMethod: 'GET' },
]
for (const contract of methodGuardContracts) {
  const response = await requestThroughVercelRuntime(runtimePath, contract)
  assert.equal(response.status, 405, `Expected ${contract.name} method guard to emit 405`)
  assert.equal(response.headers.get('Allow'), contract.allowedMethod)
  assert.deepEqual(await response.json(), {
    error: 'This wrapper API endpoint does not support the requested method.',
    code: 'method_not_allowed',
    ...(contract.name === 'action' ? { sessionInvalidated: false } : {}),
  })
}

console.log(
  `Verified ${artifacts.size} Vercel wrapper function artifacts through the @vercel/node HTTP runtime.`,
)
