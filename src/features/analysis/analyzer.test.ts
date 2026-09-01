import { describe, expect, it } from 'vitest'
import { createLimitedAnalysis, normalizeWebsiteUrl } from './analyzer'

describe('normalizeWebsiteUrl', () => {
  it('adds HTTPS when a protocol is omitted', () => {
    expect(normalizeWebsiteUrl('webmcp.dev')).toBe('https://webmcp.dev/')
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
    'https://192.0.2.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://[::1]',
    'https://[64:ff9b:1::1]',
    'https://[64:ff9b:1::]',
    'https://[64:ff9b:1:ffff:ffff:ffff:ffff:ffff]',
    'https://[64:ff9b:1::7f00:1]',
    'https://[64:ff9b:1::a00:1]',
    'https://[64:ff9b:1::c0a8:101]',
    'https://[64:ff9b::7f00:1]',
    'https://[64:ff9b::a00:1]',
    'https://[64:ff9b::a9fe:a9fe]',
    'https://[64:ff9b::0808:0808]',
    'https://[64:ff9b::5db8:d822]',
    'https://[64:ff9b:0:ffff:ffff:ffff:ffff:ffff]',
    'https://[64:ff9b:2::1]',
    'https://[100:0:0:1::1]',
    'https://[2001:1::1]',
    'https://[2001:3::1]',
    'https://[2001:4:112::1]',
    'https://[2001:30::1]',
    'https://[2001:11::1]',
    'https://[2001:21::1]',
    'https://[2001:db8::1]',
    'https://[2002::1]',
    'https://[3fff::1]',
    'https://[ff02::1]',
    'https://router.home.arpa',
    'https://site.test',
    'https://example.invalid',
    'https://example.com',
    'https://router.local',
    'https://foo..com',
    'https://-foo.com',
    'https://foo-.com',
    'https://foo_com',
  ])('rejects the non-public address %s', (value) => {
    expect(() => normalizeWebsiteUrl(value)).toThrow(
      'not a local, private, or reserved address',
    )
  })

  it.each([
    'https://valid-domain.com',
    'https://subdomain.webmcp.dev',
    'https://xn--mnich-kva.example.de',
  ])('accepts the valid public DNS hostname %s', (value) => {
    expect(normalizeWebsiteUrl(value)).toBe(new URL(value).toString())
  })

  it.each([
    'https://[2606:4700:4700::1111]',
    'https://[2001:4860:4860::8888]',
  ])('accepts the globally reachable IPv6 address %s', (value) => {
    expect(normalizeWebsiteUrl(value)).toBe(new URL(value).toString())
  })

  it('preserves an explicit port on a public hostname', () => {
    expect(normalizeWebsiteUrl('webmcp.dev:8443/path')).toBe(
      'https://webmcp.dev:8443/path',
    )
  })
})

describe('createLimitedAnalysis', () => {
  it('never fabricates capabilities for an uninspected URL', () => {
    const result = createLimitedAnalysis('https://webmcp.dev/products')
    expect(result.limited).toBe(true)
    expect(result.analysis.capabilities).toEqual([])
    expect(result.analysis.forms).toEqual([])
    expect(result.limitation).toContain('No capabilities were inferred')
  })
})
