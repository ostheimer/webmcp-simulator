// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WrapperAnalysis } from './features/wrapper/types'

const { analyzeWebsiteInWrapper, closeWrapperSession, readWrapperHealth } = vi.hoisted(() => ({
  analyzeWebsiteInWrapper: vi.fn(),
  closeWrapperSession: vi.fn(),
  // Keeps the landing screen's health read hermetic instead of attempting a
  // real request from jsdom.
  readWrapperHealth: vi.fn(async () => null),
}))

vi.mock('./features/wrapper/wrapperApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('./features/wrapper/wrapperApi')>()
  return {
    ...original,
    analyzeWebsiteInWrapper,
    closeWrapperSession,
    readWrapperHealth,
  }
})

import App from './App'

const wrapperAnalysis: WrapperAnalysis = {
  sessionId: 'late-session',
  sessionToken: 'late-token',
  requestedUrl: 'https://public.example.at/',
  finalUrl: 'https://public.example.at/',
  title: 'Late wrapper result',
  screenshotDataUrl: 'data:image/jpeg;base64,AA==',
  domEvidence: [],
  axEvidence: [],
  capabilities: [],
  warnings: [],
  blockedRequests: 0,
  analyzedPages: 1,
  maxPages: 10,
  expiresAt: '2026-08-30T10:05:00.000Z',
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
}

function startAnalysis() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Public website URL' }), {
    target: { value: 'https://public.example.at/' },
  })
  fireEvent.click(screen.getByRole('button', { name: /Analyze website/ }))
}

describe('App wrapper analysis lifecycle', () => {
  beforeEach(() => {
    analyzeWebsiteInWrapper.mockReset()
    closeWrapperSession.mockReset()
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('keeps the demo visible and closes a late wrapper result after leaving the landing view', async () => {
    let resolveAnalysis!: (analysis: WrapperAnalysis) => void
    analyzeWebsiteInWrapper.mockImplementation((_url: string, signal?: AbortSignal) =>
      new Promise<WrapperAnalysis>((resolve) => {
        resolveAnalysis = resolve
        expect(signal).toBeInstanceOf(AbortSignal)
      }))
    render(<App />)

    startAnalysis()
    await waitFor(() => expect(analyzeWebsiteInWrapper).toHaveBeenCalledOnce())
    const signal = analyzeWebsiteInWrapper.mock.calls[0][1] as AbortSignal
    fireEvent.click(screen.getByRole('button', { name: /Try the HeatFlow demo/ }))

    expect(signal.aborted).toBe(true)
    expect(await screen.findByRole('heading', { name: 'Potential capabilities, made visible.' })).toBeTruthy()
    await act(async () => resolveAnalysis(wrapperAnalysis))

    expect(screen.getByRole('heading', { name: 'Potential capabilities, made visible.' })).toBeTruthy()
    expect(screen.queryByText('Late wrapper result')).toBeNull()
    expect(closeWrapperSession).toHaveBeenCalledOnce()
    expect(closeWrapperSession).toHaveBeenCalledWith('late-session', 'late-token')
  })

  it('does not surface an analysis error when leaving aborts without a result', async () => {
    analyzeWebsiteInWrapper.mockImplementation((_url: string, signal?: AbortSignal) =>
      new Promise<WrapperAnalysis>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }))
    render(<App />)

    startAnalysis()
    await waitFor(() => expect(analyzeWebsiteInWrapper).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: /Try the HeatFlow demo/ }))
    await screen.findByRole('heading', { name: 'Potential capabilities, made visible.' })
    fireEvent.click(screen.getByRole('button', { name: 'New analysis' }))

    expect(await screen.findByRole('heading', { name: /See what your website could become/ })).toBeTruthy()
    expect(screen.queryByText(/isolated browser operation/i)).toBeNull()
    expect(closeWrapperSession).not.toHaveBeenCalled()
  })
})
