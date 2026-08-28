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
      untrustedContentHint: true,
    },
    execute: async (input, options) => {
      const signal = options?.signal ?? new AbortController().signal
      if (signal.aborted) throw new DOMException('The tool call was cancelled.', 'AbortError')
      const result = await handlers.execute(capability, input, signal)
      const text = result.structuredContent.networkPolicy === 'blocked-after-preparation'
        ? 'Prepared visible state in the isolated page. All action-time and later page network requests remain blocked for this session.'
        : 'Opened a same-origin page in the isolated browser. Only document and static-resource GET/HEAD reads were allowed for this explicit navigation.'
      return {
        content: [{
          type: 'text',
          text,
        }],
        structuredContent: result.structuredContent,
      }
    },
  }))
}
