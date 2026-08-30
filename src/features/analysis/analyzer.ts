import type { WebsiteAnalysis } from '../../types/analysis.ts'

export interface AnalysisAttempt {
  analysis: WebsiteAnalysis
  limited: boolean
  limitation?: string
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split('.').map(Number)
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null
}

function parseIpv6(value: string): bigint | null {
  const doubleColonIndex = value.indexOf('::')
  if (doubleColonIndex !== value.lastIndexOf('::')) return null

  const hasCompression = doubleColonIndex >= 0
  const [head = '', tail = ''] = hasCompression
    ? [value.slice(0, doubleColonIndex), value.slice(doubleColonIndex + 2)]
    : [value, '']

  function parseHextets(part: string): number[] | null {
    if (!part) return []
    const segments = part.split(':')
    const last = segments.at(-1)
    if (last?.includes('.')) {
      const ipv4 = parseIpv4(last)
      if (!ipv4) return null
      segments.splice(-1, 1,
        ((ipv4[0] << 8) | ipv4[1]).toString(16),
        ((ipv4[2] << 8) | ipv4[3]).toString(16),
      )
    }
    if (!segments.every((segment) => /^[\da-f]{1,4}$/i.test(segment))) return null
    return segments.map((segment) => Number.parseInt(segment, 16))
  }

  const headHextets = parseHextets(head)
  const tailHextets = parseHextets(tail)
  if (!headHextets || !tailHextets) return null

  const explicitCount = headHextets.length + tailHextets.length
  if ((!hasCompression && explicitCount !== 8) || (hasCompression && explicitCount >= 8)) {
    return null
  }

  const hextets = hasCompression
    ? [...headHextets, ...Array<number>(8 - explicitCount).fill(0), ...tailHextets]
    : headHextets
  return hextets.reduce((address, hextet) => (address << 16n) | BigInt(hextet), 0n)
}

function isInIpv6Cidr(address: bigint, block: string, prefixLength: number): boolean {
  const base = parseIpv6(block)
  if (base === null) throw new Error(`Invalid internal IPv6 CIDR block: ${block}`)
  const shift = BigInt(128 - prefixLength)
  return (address >> shift) === (base >> shift)
}

function isNonPublicIpv4(parts: number[]): boolean {
  const [first, second, third] = parts
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 0 && third === 0)
    || (first === 192 && second === 0 && third === 2)
    || (first === 192 && second === 168)
    || (first === 192 && second === 88 && third === 99)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && third === 100)
    || (first === 203 && second === 0 && third === 113)
    || first >= 224
}

// Source: IANA IPv6 Special-Purpose Address Space registry. These broad ranges
// deliberately match the Sandbox firewall deny list. Even more-specific public
// exceptions remain unsupported until the network policy can carve them out.
const nonPublicGlobalUnicastRanges = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const

// Source: IANA Special-Use Domain Names registry. The designation applies to
// each listed name and all of its subdomains. Reverse-DNS zones are grouped by
// their common suffix because none is a public website destination.
const specialUseDomainSuffixes = [
  'alt',
  '6tisch.arpa',
  'eap.arpa',
  'eap-noob.arpa',
  'home.arpa',
  'in-addr.arpa',
  'ip6.arpa',
  'ipv4only.arpa',
  'resolver.arpa',
  'service.arpa',
  'example',
  'example.com',
  'example.net',
  'example.org',
  'invalid',
  'local',
  'localhost',
  'onion',
  'test',
] as const

function isNonPublicIpv6(value: string): boolean {
  const address = parseIpv6(value)
  if (address === null) return true

  // The Sandbox firewall denies this entire translator range. Reject it here
  // as well so every accepted target is reachable under the generated policy.
  if (isInIpv6Cidr(address, '64:ff9b::', 96)) {
    return true
  }

  const isGlobalUnicast = isInIpv6Cidr(address, '2000::', 3)
  return !isGlobalUnicast || nonPublicGlobalUnicastRanges.some(
    ([block, prefix]) => isInIpv6Cidr(address, block, prefix),
  )
}

export function isPublicNetworkAddress(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/g, '')
  const ipv4 = parseIpv4(normalized)
  if (ipv4) return !isNonPublicHostname(normalized)
  if (normalized.includes(':')) return !isNonPublicIpv6(normalized)
  return false
}

function isValidDnsHostname(hostname: string): boolean {
  if (hostname.length > 253 || !hostname.includes('.')) return false
  return hostname.split('.').every(
    (label) => label.length >= 1
      && label.length <= 63
      && /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label),
  )
}

function isNonPublicHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (
    specialUseDomainSuffixes.some(
      (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
    )
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
  ) return true

  const ipv4 = parseIpv4(hostname)
  if (ipv4) {
    return isNonPublicIpv4(ipv4)
  }

  if (hostname.includes(':')) {
    return isNonPublicIpv6(hostname)
  }

  return !isValidDnsHostname(hostname)
}

export function normalizeWebsiteUrl(value: string): string {
  const candidate = value.trim()
  const looksLikeHostPort = /^[^/?#]+:\d+(?:[/?#]|$)/.test(candidate)
  const explicitScheme = candidate.match(/^([a-z][a-z\d+.-]*):/i)
  if (explicitScheme && !looksLikeHostPort) {
    const scheme = explicitScheme[1].toLowerCase()
    if (!['http', 'https'].includes(scheme) || !/^https?:\/\//i.test(candidate)) {
      throw new Error('Enter a public HTTP or HTTPS website URL.')
    }
  }
  const withProtocol = /^https?:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`
  const url = new URL(withProtocol)

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Enter a public HTTP or HTTPS website URL.')
  }

  if (url.username || url.password) {
    throw new Error('URLs containing credentials are not supported.')
  }

  if (isNonPublicHostname(url.hostname)) {
    throw new Error('Enter a public website URL, not a local, private, or reserved address.')
  }

  return url.toString()
}

export function createLimitedAnalysis(value: string): AnalysisAttempt {
  const url = normalizeWebsiteUrl(value)
  const hostname = new URL(url).hostname

  return {
    limited: true,
    limitation:
      'This browser-only MVP observed the URL but could not inspect the remote page safely. No capabilities were inferred. Use the deterministic HeatFlow demo to experience the complete flow.',
    analysis: {
      url,
      title: hostname,
      description: 'Only the submitted URL was observed.',
      sections: [],
      forms: [],
      links: [],
      capabilities: [],
    },
  }
}
