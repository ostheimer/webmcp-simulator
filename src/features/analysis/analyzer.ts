import type { WebsiteAnalysis } from '../../types/analysis'

export interface AnalysisAttempt {
  analysis: WebsiteAnalysis
  limited: boolean
  limitation?: string
}

function isNonPublicHostname(value: string): boolean {
  const hostname = value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname.endsWith('.lan')
  ) return true

  const ipv4 = hostname.split('.').map(Number)
  if (
    ipv4.length === 4
    && ipv4.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
  ) {
    const [first, second, third] = ipv4
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

  if (hostname.includes(':')) {
    return hostname === '::'
      || hostname === '::1'
      || hostname.startsWith('100:')
      || hostname.startsWith('2001:2:')
      || hostname.startsWith('2001:10:')
      || hostname.startsWith('2001:20:')
      || hostname.startsWith('2001:db8:')
      || hostname.startsWith('fc')
      || hostname.startsWith('fd')
      || /^fe[89ab]/.test(hostname)
      || hostname.startsWith('ff')
      || hostname.startsWith('::ffff:')
  }

  return !hostname.includes('.')
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
