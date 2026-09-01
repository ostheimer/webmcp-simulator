/**
 * Product-facing copy for wrapper failures.
 *
 * The wrapper service raises errors for operators as well as visitors, and some
 * of those messages name internal configuration. A visitor must never be shown
 * an environment variable, so every code that can reach the landing screen is
 * translated here. Unmapped codes keep the service message, which is already
 * written for a general audience.
 */

const ERROR_COPY: Record<string, string> = {
  sandbox_not_configured:
    'Analyzing your own website runs a real browser in an isolated sandbox, which is not enabled on this public deployment. Try the HeatFlow demo below to experience the WebMCP tools, or run the wrapper locally — the repository README explains how.',
  sandbox_capacity:
    'All isolated browser sessions are currently in use. Wait a moment and try again, or try the HeatFlow demo below.',
  unsupported_page:
    'This page cannot be isolated safely. Sites that block automation, require consent walls or fail to render are reported as unsupported rather than bypassed.',
  invalid_target:
    'Only public websites reachable over HTTP or HTTPS can be analyzed. Private, local and reserved addresses are rejected.',
  analysis_timeout:
    'The isolated browser did not finish within its time limit. Try again, or try a lighter page.',
  page_limit:
    'This session reached its page limit. Start a new analysis to continue.',
  session_expired:
    'The isolated session expired. Sessions are deliberately short-lived — start a new analysis.',
}

export function wrapperErrorCopy(code: string | undefined, fallbackMessage: string): string {
  if (code && code in ERROR_COPY) return ERROR_COPY[code]
  return fallbackMessage
}

export function hasWrapperErrorCopy(code: string | undefined): boolean {
  return typeof code === 'string' && code in ERROR_COPY
}
