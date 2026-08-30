// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebMcpTool } from '../../webmcp/registerTools'
import type { WrapperActionResult, WrapperAnalysis } from './types'
import { WrapperApiError } from './wrapperApi'

const { executeWrapperAction, closeWrapperSession } = vi.hoisted(() => ({
  executeWrapperAction: vi.fn(),
  closeWrapperSession: vi.fn(),
}))

vi.mock('./wrapperApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('./wrapperApi')>()
  return {
    ...original,
    executeWrapperAction,
    closeWrapperSession,
  }
})

import { WrapperProofWorkspace } from './WrapperProofWorkspace'

const analysis: WrapperAnalysis = {
  sessionId: 'session-current',
  sessionToken: 'token-current',
  requestedUrl: 'https://public.example.at/',
  finalUrl: 'https://public.example.at/',
  title: 'Current isolated page',
  screenshotDataUrl: 'data:image/jpeg;base64,AA==',
  domEvidence: [],
  axEvidence: [],
  warnings: [],
  blockedRequests: 0,
  analyzedPages: 1,
  maxPages: 10,
  expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  runtime: {
    provider: 'local-playwright',
    runtimeMs: 100,
    vcpus: 2,
    memoryMb: 4096,
    allowedNetworkRequests: 1,
    blockedNetworkRequests: 0,
    estimatedCost: {
      currency: 'USD',
      lowerBound: 0,
      upperBound: 0.0001,
      basis: 'illustrative-list-price',
    },
  },
  createdAt: '2026-08-30T10:00:00.000Z',
  capabilities: [{
    id: 'capability-current',
    name: 'prepare_page_search',
    title: 'Prepare a page search',
    description: 'Prepare the visible search control.',
    kind: 'prepare_search',
    inputSchema: { type: 'object' },
    evidenceIds: [],
    sampleInput: { query: 'New York' },
  }],
}

function actionResult(nextAnalysis: WrapperAnalysis): WrapperActionResult {
  return {
    finalUrl: nextAnalysis.finalUrl,
    screenshotDataUrl: nextAnalysis.screenshotDataUrl,
    analysis: nextAnalysis,
    activity: {
      id: 'activity-current',
      toolName: 'prepare_page_search',
      summary: 'Prepared the visible search.',
      createdAt: new Date().toISOString(),
    },
    structuredContent: {
      toolName: 'prepare_page_search',
      actionKind: 'prepare_search',
      finalUrl: nextAnalysis.finalUrl,
      isolatedStateChanged: true,
      targetStateVerified: true,
      networkPolicy: 'blocked-after-preparation',
      allowedNetworkRequests: 0,
      blockedNetworkRequests: 0,
      formSubmissionPrevented: true,
      navigationOccurred: false,
    },
  }
}

describe('WrapperProofWorkspace invalidation lifecycle', () => {
  let registeredTool: WebMcpTool | undefined
  let registrationSignal: AbortSignal | undefined

  beforeEach(() => {
    registeredTool = undefined
    registrationSignal = undefined
    executeWrapperAction.mockReset()
    closeWrapperSession.mockReset()
    Object.defineProperty(document, 'modelContext', {
      configurable: true,
      value: {
        registerTool: vi.fn(async (tool: WebMcpTool, options: { signal: AbortSignal }) => {
          registeredTool = tool
          registrationSignal = options.signal
        }),
      },
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    Reflect.deleteProperty(document, 'modelContext')
  })

  it('unregisters tools, clears the analysis, and shows reanalysis after trusted invalidation', async () => {
    executeWrapperAction.mockRejectedValue(new WrapperApiError(
      'The isolated browser operation failed.',
      { code: 'action_failed', sessionInvalidated: true },
    ))
    render(<WrapperProofWorkspace analysis={analysis} onBack={vi.fn()} />)
    await waitFor(() => expect(registeredTool).toBeDefined())

    await expect(registeredTool!.execute(
      { query: 'x' },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ sessionInvalidated: true })

    await screen.findByText('Browser-Sitzung beendet')
    expect(registrationSignal!.aborted).toBe(true)
    expect(closeWrapperSession).toHaveBeenCalledOnce()
    expect(closeWrapperSession).toHaveBeenCalledWith('session-current', 'token-current')
    expect(screen.queryByText('Current isolated page')).toBeNull()
    expect(screen.queryByText('prepare_page_search')).toBeNull()
    expect(screen.getByRole('button', { name: 'Website erneut analysieren' })).toBeTruthy()
  })

  it('keeps the current analysis and tools after a proven pre-action rejection', async () => {
    executeWrapperAction.mockRejectedValue(new WrapperApiError(
      'The requested input is invalid.',
      { code: 'invalid_action', sessionInvalidated: false },
    ))
    render(<WrapperProofWorkspace analysis={analysis} onBack={vi.fn()} />)
    await waitFor(() => expect(registeredTool).toBeDefined())

    await expect(registeredTool!.execute(
      { query: '' },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ sessionInvalidated: false })

    await screen.findByText('The requested input is invalid.')
    expect(registrationSignal!.aborted).toBe(false)
    expect(closeWrapperSession).not.toHaveBeenCalled()
    expect(screen.getByText('Current isolated page')).toBeTruthy()
    expect(screen.getByText('prepare_page_search')).toBeTruthy()
    expect(screen.queryByText('Browser-Sitzung beendet')).toBeNull()
  })

  it('retires local state when an accepted tool call is aborted with uncertain server state', async () => {
    executeWrapperAction.mockImplementation(async (
      _sessionId: string,
      _sessionToken: string,
      _capabilityId: string,
      _toolName: string,
      _input: Record<string, unknown>,
      signal?: AbortSignal,
    ) => await new Promise((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    render(<WrapperProofWorkspace analysis={analysis} onBack={vi.fn()} />)
    await waitFor(() => expect(registeredTool).toBeDefined())
    const controller = new AbortController()
    const pending = registeredTool!.execute({ query: 'x' }, { signal: controller.signal })
    await waitFor(() => expect(executeWrapperAction).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await screen.findByText('Browser-Sitzung beendet')
    expect(registrationSignal!.aborted).toBe(true)
    expect(closeWrapperSession).toHaveBeenCalledOnce()
    expect(closeWrapperSession).toHaveBeenCalledWith('session-current', 'token-current')
    expect(screen.queryByText('Current isolated page')).toBeNull()
    expect(screen.queryByText('prepare_page_search')).toBeNull()
    expect(screen.getByText(/Zustand der isolierten Sitzung ist nicht mehr eindeutig/)).toBeTruthy()
  })

  it('does not call the backend for an already-aborted tool invocation', async () => {
    render(<WrapperProofWorkspace analysis={analysis} onBack={vi.fn()} />)
    await waitFor(() => expect(registeredTool).toBeDefined())
    const controller = new AbortController()
    controller.abort()

    await expect(registeredTool!.execute(
      { query: 'cancelled' },
      { signal: controller.signal },
    )).rejects.toMatchObject({ name: 'AbortError' })

    expect(executeWrapperAction).not.toHaveBeenCalled()
    expect(closeWrapperSession).not.toHaveBeenCalled()
    expect(screen.getByText('Current isolated page')).toBeTruthy()
  })

  it('retires tools when the action error lacks an explicit trusted non-mutating false', async () => {
    executeWrapperAction.mockRejectedValue(new WrapperApiError(
      'The action response did not prove whether the session survived.',
      { code: 'internal_error' },
    ))
    render(<WrapperProofWorkspace analysis={analysis} onBack={vi.fn()} />)
    await waitFor(() => expect(registeredTool).toBeDefined())

    await expect(registeredTool!.execute(
      { query: 'x' },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ sessionInvalidated: undefined })

    await screen.findByText('Browser-Sitzung beendet')
    expect(registrationSignal!.aborted).toBe(true)
    expect(closeWrapperSession).toHaveBeenCalledOnce()
    expect(closeWrapperSession).toHaveBeenCalledWith('session-current', 'token-current')
    expect(screen.queryByText('Current isolated page')).toBeNull()
    expect(screen.queryByText('prepare_page_search')).toBeNull()
  })

  it('retires exactly at the local deadline and blocks retained callbacks without a backend request', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-08-30T10:00:00.000Z')
    vi.setSystemTime(now)
    const expiringAnalysis = {
      ...analysis,
      expiresAt: new Date(now.getTime() + 1_000).toISOString(),
    }
    render(<WrapperProofWorkspace analysis={expiringAnalysis} onBack={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    expect(registeredTool).toBeDefined()
    const retainedTool = registeredTool!

    await act(async () => { await vi.advanceTimersByTimeAsync(999) })
    expect(screen.getByText('Current isolated page')).toBeTruthy()
    expect(registrationSignal!.aborted).toBe(false)

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(screen.getByText('Browser-Sitzung beendet')).toBeTruthy()
    expect(screen.getByText(/Browser-Sitzung ist abgelaufen/)).toBeTruthy()
    expect(registrationSignal!.aborted).toBe(true)
    expect(closeWrapperSession).toHaveBeenCalledOnce()

    await expect(retainedTool.execute(
      { query: 'late' },
      { signal: new AbortController().signal },
    )).rejects.toMatchObject({ code: 'session_expired' })
    expect(executeWrapperAction).not.toHaveBeenCalled()
    expect(closeWrapperSession).toHaveBeenCalledOnce()
  })

  it('keeps the expiry notice and closes once when the deadline aborts a pending action', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-08-30T10:00:00.000Z')
    vi.setSystemTime(now)
    const expiringAnalysis = {
      ...analysis,
      expiresAt: new Date(now.getTime() + 1_000).toISOString(),
    }
    let backendSignal: AbortSignal | undefined
    let resolveAction!: (value: WrapperActionResult) => void
    executeWrapperAction.mockImplementation(async (
      _sessionId: string,
      _sessionToken: string,
      _capabilityId: string,
      _toolName: string,
      _input: Record<string, unknown>,
      signal?: AbortSignal,
    ) => {
      backendSignal = signal
      return await new Promise((resolve) => { resolveAction = resolve })
    })
    render(<WrapperProofWorkspace analysis={expiringAnalysis} onBack={vi.fn()} />)
    await act(async () => { await Promise.resolve() })
    const pending = registeredTool!.execute(
      { query: 'pending' },
      { signal: new AbortController().signal },
    )
    const rejectedPending = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await act(async () => { await Promise.resolve() })
    expect(executeWrapperAction).toHaveBeenCalledOnce()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(backendSignal?.aborted).toBe(true)
    resolveAction(actionResult({ ...expiringAnalysis, title: 'Stale late result' }))
    await act(async () => { await Promise.resolve() })
    await rejectedPending
    expect(screen.getByText('Browser-Sitzung beendet')).toBeTruthy()
    expect(screen.getByText(/Browser-Sitzung ist abgelaufen/)).toBeTruthy()
    expect(screen.queryByText(/Zustand der isolierten Sitzung ist nicht mehr eindeutig/)).toBeNull()
    expect(screen.queryByText('Stale late result')).toBeNull()
    expect(closeWrapperSession).toHaveBeenCalledOnce()
  })

  it('replaces the old deadline when a fresh analysis result arrives', async () => {
    vi.useFakeTimers()
    const now = new Date('2026-08-30T10:00:00.000Z')
    vi.setSystemTime(now)
    const expiringAnalysis = {
      ...analysis,
      expiresAt: new Date(now.getTime() + 1_000).toISOString(),
    }
    const refreshedAnalysis = {
      ...analysis,
      title: 'Refreshed isolated page',
      expiresAt: new Date(now.getTime() + 5_000).toISOString(),
    }
    executeWrapperAction.mockResolvedValue(actionResult(refreshedAnalysis))
    render(<WrapperProofWorkspace analysis={expiringAnalysis} onBack={vi.fn()} />)
    await act(async () => { await Promise.resolve() })

    await act(async () => {
      await registeredTool!.execute(
        { query: 'fresh' },
        { signal: new AbortController().signal },
      )
    })
    expect(screen.getByText('Refreshed isolated page')).toBeTruthy()

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(screen.getByText('Refreshed isolated page')).toBeTruthy()
    expect(closeWrapperSession).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
    expect(screen.getByText('Browser-Sitzung beendet')).toBeTruthy()
    expect(closeWrapperSession).toHaveBeenCalledOnce()
  })

  it.each([
    ['malformed', 'not-a-deadline'],
    ['already expired', '2026-08-30T09:59:59.000Z'],
  ])('fails closed for an %s analysis deadline before registering tools', async (_label, expiresAt) => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-30T10:00:00.000Z'))
    render(<WrapperProofWorkspace analysis={{ ...analysis, expiresAt }} onBack={vi.fn()} />)
    await act(async () => { await Promise.resolve() })

    expect(registeredTool).toBeUndefined()
    expect(screen.getByText('Browser-Sitzung beendet')).toBeTruthy()
    expect(screen.getByText(/Browser-Sitzung ist abgelaufen/)).toBeTruthy()
    expect(closeWrapperSession).toHaveBeenCalledOnce()
  })
})
