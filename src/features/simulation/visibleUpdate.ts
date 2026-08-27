type TimerHandle = ReturnType<typeof globalThis.setTimeout>

interface VisibleUpdateOptions {
  visibilityState?: DocumentVisibilityState
  requestFrame?: typeof requestAnimationFrame
  scheduleTimeout?: (callback: () => void, delay: number) => TimerHandle
  cancelTimeout?: (handle: TimerHandle) => void
  timeoutMs?: number
}

interface VisibleSection {
  focus: (options?: FocusOptions) => void
  scrollIntoView: (options?: ScrollIntoViewOptions) => void
}

interface RevealSectionOptions {
  resolveElement?: (id: string) => VisibleSection | null
  waitForUpdate?: () => Promise<void>
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

/**
 * Waits for a tab change to render, then brings the changed section into the
 * viewport and waits once more so tool completion stays tied to visible UI.
 */
export async function revealVisibleSection(
  sectionId: string,
  options: RevealSectionOptions = {},
): Promise<boolean> {
  const waitForUpdate = options.waitForUpdate ?? waitForVisibleUpdate
  const resolveElement = options.resolveElement
    ?? ((id: string) => document.getElementById(id))

  await waitForUpdate()
  const section = resolveElement(sectionId)
  if (!section) return false

  section.focus({ preventScroll: true })
  section.scrollIntoView({ block: 'start' })
  await waitForUpdate()
  return true
}
