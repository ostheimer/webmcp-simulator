import type { WrapperActionResult, WrapperAnalysis } from './types'

export class WrapperApiError extends Error {
  readonly code: string | undefined
  readonly sessionInvalidated: boolean | undefined

  constructor(message: string, options: { code?: string, sessionInvalidated?: boolean } = {}) {
    super(message)
    this.name = 'WrapperApiError'
    this.code = options.code
    this.sessionInvalidated = typeof options.sessionInvalidated === 'boolean'
      ? options.sessionInvalidated
      : undefined
  }
}

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
  const rawBody = await response.text()
  let parsedBody: unknown
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : undefined
  } catch {
    parsedBody = undefined
  }
  const body = parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
    ? parsedBody as {
        error?: unknown
        code?: unknown
        sessionInvalidated?: unknown
      }
    : undefined
  if (!response.ok) {
    throw new WrapperApiError(
      typeof body?.error === 'string' ? body.error : `Wrapper request failed (${response.status}).`,
      {
        code: typeof body?.code === 'string' ? body.code : undefined,
        sessionInvalidated: typeof body?.sessionInvalidated === 'boolean'
          ? body.sessionInvalidated
          : undefined,
      },
    )
  }
  if (!body) {
    throw new WrapperApiError(
      'The wrapper service returned an invalid response.',
      { code: 'invalid_response' },
    )
  }
  return body as T
}

export interface WrapperHealth {
  ready: boolean
  mode: string | undefined
  configuration: string | undefined
}

/**
 * Reads the wrapper health contract so the landing screen can state up front
 * whether live analysis is available on this deployment.
 *
 * Any failure resolves to `null` rather than throwing. An unreachable or
 * malformed health endpoint must never block or alter the landing screen.
 */
export async function readWrapperHealth(signal?: AbortSignal): Promise<WrapperHealth | null> {
  try {
    const response = await fetch('/api/wrapper/health', { signal })
    if (!response.ok) return null
    const body: unknown = await response.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null
    const record = body as Record<string, unknown>
    if (typeof record.ready !== 'boolean') return null
    return {
      ready: record.ready,
      mode: typeof record.mode === 'string' ? record.mode : undefined,
      configuration: typeof record.configuration === 'string' ? record.configuration : undefined,
    }
  } catch {
    return null
  }
}

export async function analyzeWebsiteInWrapper(url: string, signal?: AbortSignal): Promise<WrapperAnalysis> {
  return readResponse(await fetch('/api/wrapper/analyze', {
    method: 'POST',
    headers: wrapperHeaders(),
    body: JSON.stringify({ url }),
    signal,
  }))
}

export async function executeWrapperAction(
  sessionId: string,
  sessionToken: string,
  capabilityId: string,
  toolName: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<WrapperActionResult> {
  return readResponse(await fetch('/api/wrapper/action', {
    method: 'POST',
    headers: wrapperHeaders(),
    body: JSON.stringify({ sessionId, sessionToken, capabilityId, toolName, input }),
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
