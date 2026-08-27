type TimerHandle = ReturnType<typeof globalThis.setTimeout>

interface VisibleUpdateOptions {
  visibilityState?: DocumentVisibilityState
  requestFrame?: typeof requestAnimationFrame
  scheduleTimeout?: (callback: () => void, delay: number) => TimerHandle
  cancelTimeout?: (handle: TimerHandle) => void
  timeoutMs?: number
}

/**
 * Gives React a chance to paint a tool result without letting background-tab
 * animation-frame throttling hold the WebMCP call open indefinitely.
 */
export function waitForVisibleUpdate(options: VisibleUpdateOptions = {}): Promise<void> {
  const visibilityState = options.visibilityState
    ?? (typeof document === 'undefined' ? 'hidden' : document.visibilityState)
  const requestFrame = options.requestFrame
    ?? (typeof requestAnimationFrame === 'function' ? requestAnimationFrame : undefined)
  const scheduleTimeout = options.scheduleTimeout ?? globalThis.setTimeout
  const cancelTimeout = options.cancelTimeout ?? globalThis.clearTimeout
  const timeoutMs = options.timeoutMs ?? 150

  if (visibilityState === 'hidden' || typeof requestFrame !== 'function') {
    return new Promise((resolve) => scheduleTimeout(resolve, 0))
  }

  return new Promise((resolve) => {
    let settled = false
    let timeoutHandle: TimerHandle
    const finish = () => {
      if (settled) return
      settled = true
      cancelTimeout(timeoutHandle)
      resolve()
    }

    timeoutHandle = scheduleTimeout(finish, timeoutMs)
    requestFrame(() => requestFrame(finish))
  })
}
