import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeWrapperSession } from './wrapperApi'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('closeWrapperSession', () => {
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
})
