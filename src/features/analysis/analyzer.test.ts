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

  it.each([
    'ftp://example.com',
    'file:///tmp/site.html',
    'mailto:owner@example.com',
  ])('rejects the explicit non-HTTP scheme in %s', (value) => {
    expect(() => normalizeWebsiteUrl(value)).toThrow(
      'Enter a public HTTP or HTTPS website URL',
    )
  })

  it.each([
    'localhost:5173',
    'http://127.0.0.1',
    'https://10.0.0.8',
    'https://172.20.0.1',
    'https://192.168.1.20',
    'https://[::1]',
    'https://router.local',
  ])('rejects the local or private address %s', (value) => {
    expect(() => normalizeWebsiteUrl(value)).toThrow(
      'not a local or private-network address',
    )
  })

  it('preserves an explicit port on a public hostname', () => {
    expect(normalizeWebsiteUrl('example.com:8443/path')).toBe(
      'https://example.com:8443/path',
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
