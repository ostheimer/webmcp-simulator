import { afterEach, describe, expect, it, vi } from 'vitest'
import { revealVisibleSection, waitForVisibleUpdate } from './visibleUpdate'

afterEach(() => {
  vi.useRealTimers()
})

describe('waitForVisibleUpdate', () => {
  it('uses a timer immediately when the document is hidden', async () => {
    vi.useFakeTimers()
    const requestFrame = vi.fn()
    const waiting = waitForVisibleUpdate({ visibilityState: 'hidden', requestFrame })

    await vi.runAllTimersAsync()
    await expect(waiting).resolves.toBeUndefined()
    expect(requestFrame).not.toHaveBeenCalled()
  })

  it('settles through the bounded timeout when animation frames are suspended', async () => {
    vi.useFakeTimers()
    const requestFrame = vi.fn()
    const waiting = waitForVisibleUpdate({
      visibilityState: 'visible',
      requestFrame,
      timeoutMs: 150,
    })

    await vi.advanceTimersByTimeAsync(150)
    await expect(waiting).resolves.toBeUndefined()
    expect(requestFrame).toHaveBeenCalledOnce()
  })
})

describe('revealVisibleSection', () => {
  it('waits for rendering, focuses and scrolls the section, then waits for paint', async () => {
    const waitForUpdate = vi.fn(async () => undefined)
    const section = {
      focus: vi.fn(),
      scrollIntoView: vi.fn(),
    }

    await expect(revealVisibleSection('services', {
      resolveElement: () => section,
      waitForUpdate,
    })).resolves.toBe(true)

    expect(waitForUpdate).toHaveBeenCalledTimes(2)
    expect(section.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(section.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
  })
})
