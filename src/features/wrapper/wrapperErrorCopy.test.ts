import { describe, expect, it } from 'vitest'
import { hasWrapperErrorCopy, wrapperErrorCopy } from './wrapperErrorCopy'

describe('wrapperErrorCopy', () => {
  it('never exposes the internal snapshot environment variable to a visitor', () => {
    const serviceMessage = 'The production browser worker is not configured. '
      + 'Set WEBMCP_SANDBOX_SNAPSHOT_ID to a reviewed Chromium snapshot before enabling live analysis.'
    const copy = wrapperErrorCopy('sandbox_not_configured', serviceMessage)

    expect(copy).not.toContain('WEBMCP_SANDBOX_SNAPSHOT_ID')
    expect(copy).not.toBe(serviceMessage)
    expect(copy).toContain('HeatFlow demo')
  })

  it('keeps the service message for codes without dedicated copy', () => {
    expect(wrapperErrorCopy('internal_error', 'Something specific failed.'))
      .toBe('Something specific failed.')
  })

  it('keeps the service message when no code is supplied', () => {
    expect(wrapperErrorCopy(undefined, 'Wrapper request failed (500).'))
      .toBe('Wrapper request failed (500).')
  })

  it('translates the remaining visitor-facing codes', () => {
    for (const code of [
      'sandbox_capacity',
      'unsupported_page',
      'invalid_target',
      'analysis_timeout',
      'page_limit',
      'session_expired',
    ]) {
      expect(hasWrapperErrorCopy(code)).toBe(true)
      expect(wrapperErrorCopy(code, 'raw service message')).not.toBe('raw service message')
    }
  })

  it('never leaks an environment variable name through any mapped code', () => {
    for (const code of [
      'sandbox_not_configured',
      'sandbox_capacity',
      'unsupported_page',
      'invalid_target',
      'analysis_timeout',
      'page_limit',
      'session_expired',
    ]) {
      expect(wrapperErrorCopy(code, 'raw')).not.toMatch(/WEBMCP_[A-Z_]+/)
    }
  })

  it('reports unknown codes as having no copy', () => {
    expect(hasWrapperErrorCopy('not_a_real_code')).toBe(false)
    expect(hasWrapperErrorCopy(undefined)).toBe(false)
  })
})
