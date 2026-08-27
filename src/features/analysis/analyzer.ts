import type { WebsiteAnalysis } from '../../types/analysis'

export interface AnalysisAttempt {
  analysis: WebsiteAnalysis
  limited: boolean
  limitation?: string
}

export function normalizeWebsiteUrl(value: string): string {
  const candidate = value.trim()
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
