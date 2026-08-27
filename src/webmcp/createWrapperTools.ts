import type {
  WrapperActionResult,
  WrapperAnalysis,
  WrapperCapability,
} from '../features/wrapper/types'
import type { WebMcpTool } from './registerTools'

export interface WrapperToolHandlers {
  execute(
    capability: WrapperCapability,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WrapperActionResult>
}
export function createWrapperTools(
  analysis: WrapperAnalysis,
  handlers: WrapperToolHandlers,
): WebMcpTool[] {
  return analysis.capabilities.map((capability) => ({
    name: capability.name,
    title: capability.title,
    description: capability.description,
    inputSchema: capability.inputSchema,
    annotations: {
      readOnlyHint: false,
      untrustedContentHint: false,
    },
    execute: async (input, options) => {
      const signal = options?.signal ?? new AbortController().signal
      if (signal.aborted) throw new DOMException('The tool call was cancelled.', 'AbortError')
      const result = await handlers.execute(capability, input, signal)
      return {
        content: [{
          type: 'text',
          text: 'Updated the isolated website session. No form was submitted and no external write action was allowed.',
        }],
        structuredContent: result.structuredContent,
      }
    },
  }))
}
