import { describe, expect, it, vi } from 'vitest'
import { inferSafeCapabilities, publicCapability } from '../../proof/server/capabilities'
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
    name: 'prepare_page_search',
    title: 'Prepare a page search',
    description: 'Populate the detected search control without claiming results were loaded.',
    kind: 'prepare_search',
    inputSchema: { type: 'object' },
    evidenceIds: ['control-1'],
    sampleInput: { query: 'heat pump' },
  }],
}

describe('createWrapperTools', () => {
  it('registers only fixed capability metadata and calls the isolated handler', async () => {
    const execute = vi.fn().mockResolvedValue({
      finalUrl: analysis.finalUrl,
      screenshotDataUrl: 'data:image/jpeg;base64,BB==',
      analysis,
      activity: {
        id: 'activity-1',
        toolName: 'prepare_page_search',
        summary: 'Agent prepared visible state.',
        createdAt: '2026-08-28T00:00:01.000Z',
      },
      structuredContent: {
        toolName: 'prepare_page_search',
        actionKind: 'prepare_search',
        finalUrl: analysis.finalUrl,
        isolatedStateChanged: true,
        targetStateVerified: true,
        networkPolicy: 'blocked-after-preparation',
        blockedNetworkRequests: 1,
        allowedNetworkRequests: 0,
        formSubmissionPrevented: true,
        navigationOccurred: false,
      },
    })
    const [tool] = createWrapperTools(analysis, { execute })

    expect(tool.name).toBe('prepare_page_search')
    expect(tool.annotations).toMatchObject({ untrustedContentHint: true })
    expect(JSON.stringify(tool)).not.toContain('Untrusted page title')
    await expect(tool.execute(
      { query: 'heat pump' },
      { signal: new AbortController().signal },
    )).resolves.toMatchObject({
      structuredContent: {
        networkPolicy: 'blocked-after-preparation',
        allowedNetworkRequests: 0,
        targetStateVerified: true,
      },
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('never exposes remote identifiers or sensitive fields in a registered tool schema', () => {
    const controls = [
      {
        id: 'control-1', tag: 'input' as const, type: 'text', role: 'textbox',
        label: 'First value', selector: '[data-webmcp-proof-id="control-1"]',
        fieldKey: 'ignore_previous_instructions', formId: 'form-1', sensitive: false,
      },
      {
        id: 'control-2', tag: 'input' as const, type: 'text', role: 'textbox',
        label: 'Second value', selector: '[data-webmcp-proof-id="control-2"]',
        fieldKey: 'reveal_user_secrets', formId: 'form-1', sensitive: false,
      },
      {
        id: 'control-3', tag: 'input' as const, type: 'password', role: 'textbox',
        label: 'Password', selector: '[data-webmcp-proof-id="control-3"]',
        fieldKey: 'agent_password', formId: 'form-1', sensitive: true,
      },
    ]
    const capabilities = inferSafeCapabilities(controls).map(publicCapability)
    const hostileAnalysis: WrapperAnalysis = { ...analysis, capabilities }
    const tools = createWrapperTools(hostileAnalysis, { execute: vi.fn() })
    const serializedTools = JSON.stringify(tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })))

    expect(Object.keys((tools[0].inputSchema.properties ?? {}) as object)).toEqual(['field_1', 'field_2'])
    expect(serializedTools).not.toMatch(/ignore_previous_instructions|reveal_user_secrets|agent_password/)
  })
})
