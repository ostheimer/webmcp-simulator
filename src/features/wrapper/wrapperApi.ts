import type { WrapperActionResult, WrapperAnalysis } from './types'

const CLIENT_STORAGE_KEY = 'webmcp-wrapper-client-id'
let fallbackClientId = ''

function wrapperClientId(): string {
  if (!fallbackClientId) fallbackClientId = crypto.randomUUID()
  try {
    const existing = sessionStorage.getItem(CLIENT_STORAGE_KEY)
    if (existing) return existing
    sessionStorage.setItem(CLIENT_STORAGE_KEY, fallbackClientId)
  } catch {
    // Session storage can be unavailable in privacy-restricted contexts.
  }
  return fallbackClientId
}

function wrapperHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-WebMCP-Client': wrapperClientId(),
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error || `Wrapper request failed (${response.status}).`)
  return body
}

export async function analyzeWebsiteInWrapper(url: string): Promise<WrapperAnalysis> {
  return readResponse(await fetch('/api/wrapper/analyze', {
    method: 'POST',
    headers: wrapperHeaders(),
    body: JSON.stringify({ url }),
  }))
}

export async function executeWrapperAction(
  sessionId: string,
  sessionToken: string,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WrapperActionResult> {
  return readResponse(await fetch('/api/wrapper/action', {
    method: 'POST',
    headers: wrapperHeaders(),
    body: JSON.stringify({ sessionId, sessionToken, toolName, input }),
    signal,
  }))
}

export function closeWrapperSession(sessionId: string, sessionToken: string): void {
  void fetch('/api/wrapper/session', {
    method: 'DELETE',
    headers: wrapperHeaders(),
    body: JSON.stringify({ sessionId, sessionToken }),
    keepalive: true,
  }).catch(() => undefined)
}
