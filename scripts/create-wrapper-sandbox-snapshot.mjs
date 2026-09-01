import { Sandbox } from '@vercel/sandbox'

const confirmation = process.env.CONFIRM_WEBMCP_SANDBOX_SNAPSHOT
if (confirmation !== 'yes') {
  throw new Error(
    'Snapshot creation uses Vercel Sandbox resources. Set CONFIRM_WEBMCP_SANDBOX_SNAPSHOT=yes only after confirming the linked project and available quota.',
  )
}

const playwrightVersion = '1.62.1'
const snapshotExpirationMs = 30 * 24 * 60 * 60 * 1000
let sandbox

try {
  sandbox = await Sandbox.create({
    name: `webmcp-wrapper-snapshot-${Date.now()}`,
    image: 'vercel/sandbox/universal:latest',
    persistent: false,
    timeout: 5 * 60 * 1000,
    resources: { vcpus: 2 },
    networkPolicy: 'allow-all',
    tags: { purpose: 'webmcp-wrapper-snapshot' },
  })
  await sandbox.runCommand({
    cmd: 'mkdir',
    args: ['-p', '/opt/webmcp-wrapper'],
    timeoutMs: 10_000,
  })
  await sandbox.writeFiles([{
    path: '/opt/webmcp-wrapper/package.json',
    content: JSON.stringify({
      name: 'webmcp-wrapper-runtime',
      private: true,
      type: 'module',
      dependencies: { playwright: playwrightVersion },
    }),
    mode: 0o600,
  }])
  const install = await sandbox.runCommand({
    cmd: 'npm',
    args: ['install', '--omit=dev', '--ignore-scripts=false'],
    cwd: '/opt/webmcp-wrapper',
    timeoutMs: 90_000,
  })
  if (install.exitCode !== 0) throw new Error(await install.stderr())
  const browser = await sandbox.runCommand({
    cmd: 'npx',
    args: ['playwright', 'install', '--with-deps', 'chromium'],
    cwd: '/opt/webmcp-wrapper',
    timeoutMs: 180_000,
  })
  if (browser.exitCode !== 0) throw new Error(await browser.stderr())

  await sandbox.update({ networkPolicy: 'deny-all' })
  const snapshot = await sandbox.snapshot({ expiration: snapshotExpirationMs })
  await sandbox.delete({ deleteOrphanSnapshots: false })
  sandbox = undefined
  process.stdout.write(`${JSON.stringify({
    snapshotId: snapshot.snapshotId,
    playwrightVersion,
    expiresInDays: 30,
    nextStep: 'Set WEBMCP_SANDBOX_SNAPSHOT_ID for Preview after review.',
  }, null, 2)}\n`)
} catch (error) {
  await sandbox?.delete({ deleteOrphanSnapshots: true }).catch(() => undefined)
  throw error
}
