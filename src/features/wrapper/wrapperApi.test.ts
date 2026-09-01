import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeWebsiteInWrapper,
  closeWrapperSession,
  executeWrapperAction,
} from './wrapperApi'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('closeWrapperSession', () => {
  it('forwards analysis cancellation to the fetch request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()

    await analyzeWebsiteInWrapper('https://public.example.at/', controller.signal)

    expect(fetchMock).toHaveBeenCalledWith('/api/wrapper/analyze', expect.objectContaining({
      signal: controller.signal,
    }))
  })

  it('attaches rejection handling to the best-effort keepalive cleanup request', async () => {
    const cleanupRequest = Promise.reject(new Error('connection closed'))
    const catchSpy = vi.spyOn(cleanupRequest, 'catch')
    const fetchMock = vi.fn().mockReturnValue(cleanupRequest)
    vi.stubGlobal('fetch', fetchMock)

    closeWrapperSession('webmcp-wrapper-abcdefghijklmnopqrstuvwx', 'A'.repeat(43))
    await Promise.resolve()

    expect(fetchMock).toHaveBeenCalledWith('/api/wrapper/session', expect.objectContaining({
      method: 'DELETE',
      keepalive: true,
    }))
    expect(catchSpy).toHaveBeenCalledOnce()
  })

  it('parses only a literal true invalidation flag from failed action responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'The isolated browser operation failed.',
        code: 'action_failed',
        sessionInvalidated: true,
      }), { status: 500 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'The requested input is invalid.',
        code: 'invalid_action',
        sessionInvalidated: false,
      }), { status: 400 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Malformed invalidation marker.',
        sessionInvalidated: 'true',
      }), { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(executeWrapperAction(
      'session',
      'token',
      'capability-current',
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({
      code: 'action_failed',
      sessionInvalidated: true,
    })
    await expect(executeWrapperAction(
      'session',
      'token',
      'capability-current',
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({
      code: 'invalid_action',
      sessionInvalidated: false,
    })
    await expect(executeWrapperAction(
      'session',
      'token',
      'capability-current',
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({ sessionInvalidated: undefined })
  })

  it('sanitizes empty, HTML, and successful non-JSON platform responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html>private gateway detail</html>', {
        status: 502,
        headers: { 'Content-Type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response('', { status: 504 }))
      .mockResolvedValueOnce(new Response('upstream success text', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(executeWrapperAction(
      'session',
      'token',
      'capability-current',
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({
      name: 'WrapperApiError',
      message: 'Wrapper request failed (502).',
      code: undefined,
      sessionInvalidated: undefined,
    })
    await expect(executeWrapperAction(
      'session',
      'token',
      'capability-current',
      'prepare_page_search',
      { query: 'x' },
    )).rejects.toMatchObject({
      name: 'WrapperApiError',
      message: 'Wrapper request failed (504).',
      code: undefined,
      sessionInvalidated: undefined,
    })
    await expect(analyzeWebsiteInWrapper('https://public.example.at/')).rejects.toMatchObject({
      name: 'WrapperApiError',
      message: 'The wrapper service returned an invalid response.',
      code: 'invalid_response',
      sessionInvalidated: undefined,
    })
  })
})
