import { createHash } from 'node:crypto'

const baseUrl = process.env.WRAPPER_PROOF_BASE_URL || 'http://127.0.0.1:5173'
const targetUrl = process.env.WRAPPER_PROOF_URL || 'https://www.scrapethissite.com/pages/forms/'
const clientId = crypto.randomUUID()

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-WebMCP-Client': clientId },
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
    sessionToken: analysis.sessionToken,
    capabilityId: capability.id,
    toolName: capability.name,
    input: capability.sampleInput,
  })
  const after = digest(action.analysis.screenshotDataUrl)
  if (before === after) throw new Error('The isolated screenshot did not change.')
  if (action.finalUrl !== action.analysis.finalUrl || !action.structuredContent.targetStateVerified) {
    throw new Error('The action did not return verified current-page state.')
  }
  if (capability.name === 'prepare_page_search') {
    if (action.structuredContent.networkPolicy !== 'blocked-after-preparation'
      || action.structuredContent.allowedNetworkRequests !== 0
      || action.structuredContent.navigationOccurred) {
      throw new Error('Search preparation did not prove the network-blocked field-state contract.')
    }
  } else if (capability.name === 'open_page_link') {
    if (action.structuredContent.networkPolicy !== 'same-origin-navigation'
      || !action.structuredContent.navigationOccurred
      || action.finalUrl === analysis.finalUrl) {
      throw new Error('Navigation did not prove a current same-origin destination.')
    }
  }
  process.stdout.write(`${JSON.stringify({
    targetUrl,
    title: analysis.title,
    domEvidence: analysis.domEvidence.length,
    axEvidence: analysis.axEvidence.length,
    blockedRequests: analysis.blockedRequests,
    toolName: capability.name,
    screenshotChanged: true,
    finalUrl: action.finalUrl,
    targetStateVerified: true,
    networkPolicy: action.structuredContent.networkPolicy,
  }, null, 2)}\n`)
} finally {
  await fetch(`${baseUrl}/api/wrapper/session`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'X-WebMCP-Client': clientId },
    body: JSON.stringify({
      sessionId: analysis.sessionId,
      sessionToken: analysis.sessionToken,
    }),
  }).catch(() => undefined)
}
