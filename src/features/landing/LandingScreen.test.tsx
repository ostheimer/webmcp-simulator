// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { readWrapperHealth } = vi.hoisted(() => ({ readWrapperHealth: vi.fn() }))

vi.mock('../wrapper/wrapperApi', async (importOriginal) => {
  const original = await importOriginal<typeof import('../wrapper/wrapperApi')>()
  return { ...original, readWrapperHealth }
})

import { LandingScreen } from './LandingScreen'

function renderLanding() {
  render(<LandingScreen onAnalyze={vi.fn(async () => null)} onDemo={vi.fn()} />)
}

const NOTICE = /not enabled on this public deployment/

beforeEach(() => {
  readWrapperHealth.mockReset()
  readWrapperHealth.mockResolvedValue(null)
})

afterEach(() => cleanup())

describe('LandingScreen deployment notice', () => {
  it('states up front that live analysis is unavailable when health reports not ready', async () => {
    readWrapperHealth.mockResolvedValue({
      ready: false,
      mode: 'vercel-sandbox',
      configuration: 'missing-browser-source',
    })
    renderLanding()

    await waitFor(() => expect(screen.getByText(NOTICE)).toBeTruthy())
  })

  it('stays silent when live analysis is ready', async () => {
    readWrapperHealth.mockResolvedValue({ ready: true, mode: 'local-proof', configuration: undefined })
    renderLanding()

    await waitFor(() => expect(readWrapperHealth).toHaveBeenCalled())
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it('stays silent when the health contract cannot be read', async () => {
    readWrapperHealth.mockResolvedValue(null)
    renderLanding()

    await waitFor(() => expect(readWrapperHealth).toHaveBeenCalled())
    expect(screen.queryByText(NOTICE)).toBeNull()
  })

  it('stays silent and does not break rendering when the health read rejects', async () => {
    readWrapperHealth.mockRejectedValue(new Error('offline'))
    renderLanding()

    await waitFor(() => expect(readWrapperHealth).toHaveBeenCalled())
    expect(screen.queryByText(NOTICE)).toBeNull()
    expect(screen.getByRole('button', { name: /Try the HeatFlow demo/ })).toBeTruthy()
  })
})

describe('LandingScreen notice and error do not duplicate each other', () => {
  it('replaces the standing notice with the specific error once analysis fails', async () => {
    readWrapperHealth.mockResolvedValue({
      ready: false,
      mode: 'vercel-sandbox',
      configuration: 'missing-browser-source',
    })
    const onAnalyze = vi.fn(async () => 'Analyzing your own website runs a real browser in an isolated sandbox.')
    render(<LandingScreen onAnalyze={onAnalyze} onDemo={vi.fn()} />)

    await waitFor(() => expect(screen.getByText(NOTICE)).toBeTruthy())

    fireEvent.change(screen.getByRole('textbox', { name: 'Public website URL' }), {
      target: { value: 'https://public.example.at/' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Analyze website/ }))

    await waitFor(() => expect(screen.getByText(/isolated sandbox\.$/)).toBeTruthy())
    expect(screen.queryByText(NOTICE)).toBeNull()
  })
})

describe('LandingScreen orientation copy', () => {
  it('states that HeatFlow is fictional and that its tools are real', async () => {
    renderLanding()

    const explainer = await screen.findByText(/heating company built into the/)
    expect(explainer.textContent).toContain('fictional')
    expect(explainer.textContent).toContain('document.modelContext')
  })

  it('shows agent test instructions for both supported clients', () => {
    renderLanding()

    expect(screen.getByRole('heading', { name: 'Google Chrome' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'ChatGPT in-app browser' })).toBeTruthy()
    expect(screen.getByText('chrome://flags/#enable-webmcp-testing')).toBeTruthy()
  })

  it('documents the executeTool contract that plain names and objects fail', () => {
    renderLanding()

    const note = screen.getByText(/takes the registered tool object/)
    expect(note.textContent).toContain('not its name')
    expect(note.textContent).toContain('JSON string')
  })
})
