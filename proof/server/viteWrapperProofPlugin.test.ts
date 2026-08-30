import { describe, expect, it, vi } from 'vitest'
import { WrapperServiceError } from './wrapperErrors.ts'
import { localPublicError } from './viteWrapperProofPlugin.ts'

describe('local wrapper API error boundary', () => {
  it('preserves invalid input and stale capability errors without retiring the local session', () => {
    expect(localPublicError(new WrapperServiceError(
      'invalid_action',
      'query must be non-empty.',
      400,
      { sessionInvalidated: false },
    ), true)).toEqual({
      status: 400,
      body: {
        error: 'query must be non-empty.',
        code: 'invalid_action',
        sessionInvalidated: false,
      },
    })
    expect(localPublicError(new WrapperServiceError(
      'invalid_action',
      'The requested tool belongs to a stale page analysis.',
      409,
      { sessionInvalidated: false },
    ), true).body.sessionInvalidated).toBe(false)
  })

  it('propagates trusted post-mutation invalidation and sanitizes unknown failures', () => {
    expect(localPublicError(new WrapperServiceError(
      'action_failed',
      'The isolated page could not safely verify the requested action.',
      409,
      { sessionInvalidated: true },
    ), true)).toEqual({
      status: 409,
      body: {
        error: 'The isolated page could not safely verify the requested action.',
        code: 'action_failed',
        sessionInvalidated: true,
      },
    })

    expect(localPublicError(new WrapperServiceError(
      'invalid_action',
      'An action error without a trusted lifecycle signal.',
      409,
    ), true).body.sessionInvalidated).toBe(true)

    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const safe = localPublicError(new Error('secret path /opt/worker and session token'), true)
    expect(safe).toEqual({
      status: 500,
      body: {
        error: 'The isolated browser operation failed.',
        code: 'internal_error',
        sessionInvalidated: true,
      },
    })
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret path|\/opt\/worker|session token/)
    log.mockRestore()
  })
})
