import { describe, expect, it } from 'vitest'
import { heatFlowCapabilities } from '../../demo/heatflow/data'
import { generateImplementationPack } from './generateImplementationPack'

describe('generateImplementationPack', () => {
  it('defaults safely when no repository or access exists', () => {
    const pack = generateImplementationPack({
      websiteUrl: 'https://heatflow.example',
      accessPath: 'no-access',
      platform: 'I do not know yet',
      capabilities: heatFlowCapabilities.slice(0, 2),
    })
    expect(pack).toContain('I do not currently have a source-code repository')
    expect(pack).toContain('Do not claim that you can modify the production website')
    expect(pack).toContain('search_services')
    expect(pack).not.toContain('prepare_quote_request')
  })

  it('asks Codex to inspect an available repository before editing', () => {
    const pack = generateImplementationPack({
      websiteUrl: 'https://heatflow.example',
      accessPath: 'repository',
      platform: '',
      capabilities: [heatFlowCapabilities[0]],
    })
    expect(pack).toContain('Inspect its framework')
    expect(pack).toContain('Reuse existing application logic')
  })
})
