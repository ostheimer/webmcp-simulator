import { describe, expect, it, vi } from 'vitest'
import type { WrapperAnalysis } from '../features/wrapper/types'
import { createWrapperTools } from './createWrapperTools'

const analysis: WrapperAnalysis = {
  sessionId: 'session-1',
  requestedUrl: 'https://public.example.at/',
  finalUrl: 'https://public.example.at/',
  title: 'Untrusted page title',
  screenshotDataUrl: 'data:image/jpeg;base64,AA==',
  domEvidence: [],
  axEvidence: [],
  warnings: [],
  blockedRequests: 0,
  createdAt: '2026-08-28T00:00:00.000Z',
  capabilities: [{
    id: 'search',
    name: 'search_page',
    title: 'Search this page',
    description: 'Populate the detected search control without submitting a form.',
    kind: 'search',
    inputSchema: { type: 'object' },
    evidenceIds: ['control-1'],
    sampleInput: { query: 'heat pump' },
  }],
}

describe('createWrapperTools', () => {
  it('registers only fixed capability metadata and calls the isolated handler', async () => {
    const execute = vi.fn().mockResolvedValue({
      screenshotDataUrl: 'data:image/jpeg;base64,BB==',
      activity: {
        id: 'activity-1',
        toolName: 'search_page',
        summary: 'Agent invoked search_page in the isolated page.',
        createdAt: '2026-08-28T00:00:01.000Z',
      },
      structuredContent: {
        toolName: 'search_page',
        isolatedStateChanged: true,
        externalSubmission: false,
      },
    })
    const [tool] = createWrapperTools(analysis, { execute })

    expect(tool.name).toBe('search_page')
    expect(JSON.stringify(tool)).not.toContain('Untrusted page title')
    await expect(tool.execute(
      { query: 'heat pump' },
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({
      structuredContent: { externalSubmission: false },
    })
    expect(execute).toHaveBeenCalledOnce()
  })
})
