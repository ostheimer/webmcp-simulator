import { describe, expect, it, vi } from 'vitest'
import { heatFlowCapabilities } from '../demo/heatflow/data'
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

  it('uses the same whole-number property-size contract everywhere', async () => {
    const callbacks = handlers()
    const tool = createHeatFlowTools(callbacks).find(
      (candidate) => candidate.name === 'prepare_quote_request',
    )!
    const proposed = heatFlowCapabilities.find(
      (capability) => capability.name === 'prepare_quote_request',
    )!

    expect(tool.inputSchema).toMatchObject({
      properties: { propertySize: { type: 'integer' } },
    })
    expect(proposed.inputSchema).toMatchObject({
      properties: { propertySize: { type: 'integer' } },
    })
    await expect(tool.execute(
      { service: 'heat_pump', postcode: '2230', propertySize: 150.5 },
      { signal: new AbortController().signal },
    )).rejects.toThrow('propertySize must be a whole number')
    expect(callbacks.prepareQuote).not.toHaveBeenCalled()
  })

  it('counts schema maxLength limits in Unicode code points', async () => {
    const callbacks = handlers()
    const tools = createHeatFlowTools(callbacks)
    const quoteTool = tools.find(
      (candidate) => candidate.name === 'prepare_quote_request',
    )!
    const searchTool = tools.find(
      (candidate) => candidate.name === 'search_services',
    )!

    await expect(quoteTool.execute(
      {
        service: 'heat_pump',
        postcode: '2230',
        propertySize: 150,
        message: '😀'.repeat(500),
      },
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ prepared: true })
    await expect(quoteTool.execute(
      {
        service: 'heat_pump',
        postcode: '2230',
        propertySize: 150,
        message: '😀'.repeat(501),
      },
      { signal: new AbortController().signal },
    )).rejects.toThrow('message must be at most 500 characters')

    await expect(searchTool.execute(
      { query: '😀'.repeat(80) },
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({ query: '😀'.repeat(80) })
    await expect(searchTool.execute(
      { query: '😀'.repeat(81) },
      { signal: new AbortController().signal },
    )).rejects.toThrow('query must be at most 80 characters')
  })

  it('advertises and enforces a non-empty search query', async () => {
    const callbacks = handlers()
    const searchTool = createHeatFlowTools(callbacks).find(
      (candidate) => candidate.name === 'search_services',
    )!
    const proposed = heatFlowCapabilities.find(
      (capability) => capability.name === 'search_services',
    )!

    expect(searchTool.inputSchema).toMatchObject({
      properties: { query: { minLength: 1, pattern: '\\S' } },
    })
    expect(proposed.inputSchema).toMatchObject({
      properties: { query: { minLength: 1, pattern: '\\S' } },
    })
    await expect(searchTool.execute(
      { query: '' },
      { signal: new AbortController().signal },
    )).rejects.toThrow('query must be a non-empty string')
    await expect(searchTool.execute(
      { query: '   ' },
      { signal: new AbortController().signal },
    )).rejects.toThrow('query must be a non-empty string')
    expect(callbacks.search).not.toHaveBeenCalled()
  })

  it('serializes concurrent visible search mutations', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const order: string[] = []
    const callbacks = {
      ...handlers(),
      search: vi.fn(async (query: string) => {
        order.push(`start:${query}`)
        if (query === 'heat pump') await firstGate
        order.push(`end:${query}`)
      }),
    }
    const searchTool = createHeatFlowTools(callbacks).find(
      (candidate) => candidate.name === 'search_services',
    )!

    const first = searchTool.execute(
      { query: 'heat pump' },
      { signal: new AbortController().signal },
    )
    await vi.waitFor(() => expect(callbacks.search).toHaveBeenCalledOnce())
    const second = searchTool.execute(
      { query: 'maintenance' },
      { signal: new AbortController().signal },
    )
    await Promise.resolve()
    expect(callbacks.search).toHaveBeenCalledOnce()

    releaseFirst()
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { query: 'heat pump' },
      { query: 'maintenance' },
    ])
    expect(order).toEqual([
      'start:heat pump',
      'end:heat pump',
      'start:maintenance',
      'end:maintenance',
    ])
  })

  it('does not run a queued visible mutation after it is aborted', async () => {
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const callbacks = {
      ...handlers(),
      search: vi.fn(async (query: string) => {
        if (query === 'heat pump') await firstGate
      }),
    }
    const searchTool = createHeatFlowTools(callbacks).find(
      (candidate) => candidate.name === 'search_services',
    )!
    const first = searchTool.execute(
      { query: 'heat pump' },
      { signal: new AbortController().signal },
    )
    await vi.waitFor(() => expect(callbacks.search).toHaveBeenCalledOnce())

    const queuedController = new AbortController()
    const queued = searchTool.execute(
      { query: 'maintenance' },
      { signal: queuedController.signal },
    )
    queuedController.abort()
    releaseFirst()

    await expect(first).resolves.toMatchObject({ query: 'heat pump' })
    await expect(queued).rejects.toMatchObject({ name: 'AbortError' })
    expect(callbacks.search).toHaveBeenCalledOnce()
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
