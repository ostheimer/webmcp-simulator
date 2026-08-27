import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHeatFlowTools } from './createHeatFlowTools'
import { registerTools, type WebMcpTool } from './registerTools'

afterEach(() => vi.unstubAllGlobals())

describe('registerTools', () => {
  it('registers every HeatFlow tool through document.modelContext', async () => {
    const registerTool = vi.fn(
      async (_tool: WebMcpTool, _options?: unknown) => undefined,
    )
    vi.stubGlobal('document', { modelContext: { registerTool } })
    const noop = async () => undefined
    const tools = createHeatFlowTools({
      search: noop,
      checkArea: noop,
      compare: noop,
      prepareQuote: noop,
      reset: noop,
    })
    const result = await registerTools(tools)
    expect(result.supported).toBe(true)
    expect(result.registeredToolNames).toHaveLength(5)
    expect(registerTool).toHaveBeenCalledTimes(5)
    expect(registerTool.mock.calls[0]?.[0].name).toBe('search_services')
    result.dispose()
  })

  it('reports unsupported browsers without pretending tools were registered', async () => {
    vi.stubGlobal('document', {})
    const result = await registerTools([])
    expect(result).toMatchObject({ supported: false, registeredToolNames: [] })
  })
})
