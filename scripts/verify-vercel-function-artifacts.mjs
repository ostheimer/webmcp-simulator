import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const handlerNames = ['analyze', 'action', 'session', 'health']
const handlers = new Map()

for (const handlerName of handlerNames) {
  const artifactPath = resolve(
    repositoryRoot,
    '.vercel',
    'output',
    'functions',
    'api',
    'wrapper',
    `${handlerName}.func`,
    'api',
    'wrapper',
    `${handlerName}.js`,
  )

  await access(artifactPath)
  const artifact = await import(pathToFileURL(artifactPath).href)
  assert.equal(
    typeof artifact.default,
    'function',
    `Expected ${handlerName} artifact to export a default handler`,
  )
  handlers.set(handlerName, artifact.default)
}

const healthResponse = await handlers.get('health')(
  new Request('https://webmcp.invalid/api/wrapper/health', { method: 'GET' }),
)
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

console.log(`Verified ${handlerNames.length} Vercel wrapper function artifacts and health invocation.`)
