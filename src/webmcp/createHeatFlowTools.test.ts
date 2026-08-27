import { describe, expect, it, vi } from 'vitest'
import { createHeatFlowTools } from './createHeatFlowTools'

function handlers() {
  return {
    search: vi.fn(async () => undefined),
    checkArea: vi.fn(async () => undefined),
    compare: vi.fn(async () => undefined),
    prepareQuote: vi.fn(async () => undefined),
    reset: vi.fn(async () => undefined),
  }
}

describe('createHeatFlowTools', () => {
  it('exposes five distinct WebMCP tools', () => {
    expect(createHeatFlowTools(handlers()).map((tool) => tool.name)).toEqual([
      'search_services',
      'check_service_area',
      'compare_services',
      'prepare_quote_request',
      'reset_simulation',
    ])
  })

  it('marks every visible-state-changing tool as non-read-only', () => {
    const annotations = createHeatFlowTools(handlers()).map((tool) => ({
      name: tool.name,
      readOnlyHint: tool.annotations?.readOnlyHint,
    }))

    expect(annotations).toEqual([
      { name: 'search_services', readOnlyHint: false },
      { name: 'check_service_area', readOnlyHint: false },
      { name: 'compare_services', readOnlyHint: false },
      { name: 'prepare_quote_request', readOnlyHint: false },
      { name: 'reset_simulation', readOnlyHint: false },
    ])
  })

  it('prepares but never submits a quote', async () => {
    const callbacks = handlers()
    const tool = createHeatFlowTools(callbacks).find(
      (candidate) => candidate.name === 'prepare_quote_request',
    )!
    const result = await tool.execute(
      {
        service: 'heat_pump',
        postcode: '2230',
        propertySize: 150,
        message: 'Please review this home.',
      },
      { signal: new AbortController().signal },
    )
    expect(callbacks.prepareQuote).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ prepared: true, submitted: false })
  })

  it('rejects invalid quote inputs before changing state', async () => {
    const callbacks = handlers()
    const tool = createHeatFlowTools(callbacks).find(
      (candidate) => candidate.name === 'prepare_quote_request',
    )!
    await expect(tool.execute(
      { service: 'heat_pump', postcode: '22', propertySize: 150 },
      { signal: new AbortController().signal },
    )).rejects.toThrow('postcode must contain exactly four digits')
    expect(callbacks.prepareQuote).not.toHaveBeenCalled()
  })
})
