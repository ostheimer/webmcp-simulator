export type WrapperErrorCode =
  | 'action_failed'
  | 'action_timeout'
  | 'analysis_timeout'
  | 'body_limit'
  | 'internal_error'
  | 'invalid_action'
  | 'invalid_capability'
  | 'invalid_target'
  | 'page_limit'
  | 'response_limit'
  | 'sandbox_capacity'
  | 'sandbox_not_configured'
  | 'session_expired'
  | 'unsupported_page'

const PUBLIC_ERROR_CODES = new Set<WrapperErrorCode>([
  'action_failed',
  'action_timeout',
  'analysis_timeout',
  'body_limit',
  'invalid_action',
  'invalid_capability',
  'invalid_target',
  'page_limit',
  'response_limit',
  'sandbox_capacity',
  'sandbox_not_configured',
  'session_expired',
  'unsupported_page',
])

export class WrapperServiceError extends Error {
  readonly code: WrapperErrorCode
  readonly status: number
  readonly sessionInvalidated: boolean | undefined

  constructor(
    code: WrapperErrorCode,
    message: string,
    status: number,
    options: { sessionInvalidated?: boolean } = {},
  ) {
    super(message)
    this.name = 'WrapperServiceError'
    this.code = code
    this.status = status
    this.sessionInvalidated = options.sessionInvalidated
  }
}

export function isPublicWrapperErrorCode(value: unknown): value is WrapperErrorCode {
  return typeof value === 'string' && PUBLIC_ERROR_CODES.has(value as WrapperErrorCode)
}

export function errorStatus(error: unknown): number | undefined {
  return error instanceof WrapperServiceError
    ? error.status
    : typeof error === 'object' && error !== null && 'status' in error
      ? Number((error as { status?: unknown }).status)
      : undefined
}
