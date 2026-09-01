// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebMcpTool } from '../../webmcp/registerTools'
import { SimulationWorkspace } from './SimulationWorkspace'

let registered: WebMcpTool[]

function tool(name: string): WebMcpTool {
  const found = registered.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`${name} was not registered`)
  return found
}

async function renderConnected(agentHighlightMs = 80) {
  render(<SimulationWorkspace onBack={() => undefined} agentHighlightMs={agentHighlightMs} />)
  await waitFor(() => expect(registered).toHaveLength(5))
  await waitFor(() => expect(screen.getByText('Connected')).toBeTruthy())
}

function section(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`#${id} is not rendered`)
  return element
}

function badgeText(element: HTMLElement): string | null {
  return element.querySelector('.agent-touch-badge')?.textContent ?? null
}

function activeToolRows(): string[] {
  return Array.from(document.querySelectorAll('.registered-tool.is-active code'))
    .map((code) => code.textContent ?? '')
}

beforeEach(() => {
  registered = []
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: {
      registerTool: vi.fn(async (definition: WebMcpTool) => {
        registered.push(definition)
      }),
    },
  })
  // jsdom does not implement scrollIntoView, which the reveal step relies on.
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'modelContext')
})

describe('SimulationWorkspace agent feedback', () => {
  it('outlines the section an agent call changed, names the tool, and clears itself', async () => {
    await renderConnected()

    await act(async () => {
      await tool('check_service_area').execute({ postcode: '1010', service: 'maintenance' })
    })

    const area = section('service-area')
    expect(area.className).toContain('agent-touched')
    expect(badgeText(area)).toContain('check_service_area')
    expect(screen.getByDisplayValue('1010').closest('label')?.className).toContain('agent-filled')
    expect(screen.getByDisplayValue('Maintenance care').closest('label')?.className).toContain('agent-filled')
    expect(activeToolRows()).toEqual(['check_service_area'])
    expect(screen.getByText('Service available')).toBeTruthy()

    await waitFor(() => expect(area.className).not.toContain('agent-touched'))
    expect(area.querySelector('.agent-touch')).toBeNull()
    expect(activeToolRows()).toEqual([])
    expect(screen.getByDisplayValue('1010').closest('label')?.className ?? '').not.toContain('agent-filled')
  })

  it('moves the emphasis to the next call and marks the cards a comparison selected', async () => {
    await renderConnected(5000)

    await act(async () => {
      await tool('search_services').execute({ query: 'heat pump' })
    })
    const services = section('services')
    expect(services.className).toContain('agent-touched')
    expect(badgeText(services)).toContain('search_services')
    expect(screen.getByPlaceholderText('Search services').closest('label')?.className).toContain('agent-filled')

    await act(async () => {
      await tool('compare_services').execute({ serviceIds: ['heat-pump-air', 'gas-hybrid'] })
    })
    expect(services.className).not.toContain('agent-touched')
    expect(services.querySelector('.agent-touch')).toBeNull()
    const comparison = section('service-comparison')
    expect(comparison.className).toContain('agent-touched')
    expect(badgeText(comparison)).toContain('compare_services')
    const pickedCards = Array.from(document.querySelectorAll('.service-card.agent-filled h3')).map((heading) => heading.textContent)
    expect(pickedCards).toEqual(['Air-source heat pump', 'Hybrid heating'])
    expect(activeToolRows()).toEqual(['compare_services'])
  })

  it('drops the emphasis as soon as a person edits what the agent prepared', async () => {
    await renderConnected(5000)

    await act(async () => {
      await tool('prepare_quote_request').execute({ service: 'heat_pump', postcode: '2230', propertySize: 150 })
    })
    const quote = section('quote-request')
    expect(quote.className).toContain('agent-touched')
    expect(badgeText(quote)).toContain('prepare_quote_request')
    const messageLabel = screen.getByPlaceholderText('What should the advisor know?').closest('label')
    expect(messageLabel?.className ?? '').not.toContain('agent-filled')
    expect(screen.getByDisplayValue('150').closest('label')?.className).toContain('agent-filled')

    fireEvent.change(screen.getByPlaceholderText('What should the advisor know?'), { target: { value: 'Old boiler' } })

    expect(quote.className).not.toContain('agent-touched')
    expect(quote.querySelector('.agent-touch')).toBeNull()
    expect(screen.getByDisplayValue('150').closest('label')?.className ?? '').not.toContain('agent-filled')
    expect(screen.getByText('Prepared by agent')).toBeTruthy()
  })

  it('never emphasises anything for purely human interaction', async () => {
    await renderConnected(5000)

    fireEvent.change(screen.getByPlaceholderText('Search services'), { target: { value: 'maintenance' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check area' }))

    expect(document.querySelector('.agent-touch')).toBeNull()
    expect(document.querySelector('.agent-filled')).toBeNull()
    expect(activeToolRows()).toEqual([])
    expect(screen.getByText('Service available')).toBeTruthy()
  })
})
