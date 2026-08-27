import { createHash } from 'node:crypto'

const baseUrl = process.env.WRAPPER_PROOF_BASE_URL || 'http://127.0.0.1:5173'
const targetUrl = process.env.WRAPPER_PROOF_URL || 'https://www.scrapethissite.com/pages/forms/'

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`)
  return result
}
function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

const analysis = await post('/api/wrapper/analyze', { url: targetUrl })
try {
  const [capability] = analysis.capabilities
  if (!capability) throw new Error('No safe capability was detected.')
  const before = digest(analysis.screenshotDataUrl)
  const action = await post('/api/wrapper/action', {
    sessionId: analysis.sessionId,
    toolName: capability.name,
    input: capability.sampleInput,
  })
  const after = digest(action.screenshotDataUrl)
  if (before === after) throw new Error('The isolated screenshot did not change.')
  if (action.structuredContent.externalSubmission !== false) {
    throw new Error('The action did not prove the no-submission boundary.')
  }
  process.stdout.write(`${JSON.stringify({
    targetUrl,
    title: analysis.title,
    domEvidence: analysis.domEvidence.length,
    axEvidence: analysis.axEvidence.length,
    blockedRequests: analysis.blockedRequests,
    toolName: capability.name,
    screenshotChanged: true,
    externalSubmission: false,
  }, null, 2)}\n`)
} finally {
  await fetch(`${baseUrl}/api/wrapper/session/${encodeURIComponent(analysis.sessionId)}`, {
    method: 'DELETE',
  }).catch(() => undefined)
}
