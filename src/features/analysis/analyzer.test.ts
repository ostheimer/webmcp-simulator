import { describe, expect, it } from 'vitest'
import { createLimitedAnalysis, normalizeWebsiteUrl } from './analyzer'

describe('normalizeWebsiteUrl', () => {
  it('adds HTTPS when a protocol is omitted', () => {
    expect(normalizeWebsiteUrl('example.com')).toBe('https://example.com/')
  })

  it('rejects embedded credentials', () => {
    expect(() => normalizeWebsiteUrl('https://user:secret@example.com')).toThrow(
      'URLs containing credentials',
    )
  })
})

describe('createLimitedAnalysis', () => {
  it('never fabricates capabilities for an uninspected URL', () => {
    const result = createLimitedAnalysis('https://example.com/products')
    expect(result.limited).toBe(true)
    expect(result.analysis.capabilities).toEqual([])
    expect(result.analysis.forms).toEqual([])
    expect(result.limitation).toContain('No capabilities were inferred')
  })
})
