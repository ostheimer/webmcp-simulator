import type { WrapperActionResult, WrapperAnalysis } from './types'

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(body.error || `Wrapper request failed (${response.status}).`)
  return body
}

export async function analyzeWebsiteInWrapper(url: string): Promise<WrapperAnalysis> {
  return readResponse(await fetch('/api/wrapper/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }))
}

export async function executeWrapperAction(
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WrapperActionResult> {
  return readResponse(await fetch('/api/wrapper/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, toolName, input }),
    signal,
  }))
}

export function closeWrapperSession(sessionId: string): void {
  void fetch(`/api/wrapper/session/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
    keepalive: true,
  })
}
