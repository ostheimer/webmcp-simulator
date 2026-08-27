export interface WebMcpTool {
  name: string
  title?: string
  description: string
  inputSchema: Record<string, unknown>
  annotations?: {
    readOnlyHint?: boolean
    untrustedContentHint?: boolean
  }
  execute: (
    input: Record<string, unknown>,
    options?: { signal: AbortSignal },
  ) => Promise<unknown>
}

export interface ToolRegistrationResult {
  supported: boolean
  registeredToolNames: string[]
  dispose: () => void
}

export interface ToolRegistrationOptions {
  controller?: AbortController
}

/**
 * Registers simulation tools with the current imperative WebMCP browser API.
 *
 * Concrete HeatFlow tool definitions live in the simulation feature and call
 * the same state transitions as the human interface. Aborting the controller
 * unregisters them when the simulation unmounts.
 */
export async function registerTools(
  tools: WebMcpTool[],
  options: ToolRegistrationOptions = {},
): Promise<ToolRegistrationResult> {
  const modelContext = document.modelContext

  if (typeof modelContext?.registerTool !== 'function') {
    return {
      supported: false,
      registeredToolNames: [],
      dispose: () => undefined,
    }
  }

  const registrationController = options.controller ?? new AbortController()

  try {
    for (const tool of tools) {
      await modelContext.registerTool(tool, {
        signal: registrationController.signal,
      })
    }
  } catch (error) {
    registrationController.abort()
    throw error
  }

  return {
    supported: true,
    registeredToolNames: tools.map((tool) => tool.name),
    dispose: () => registrationController.abort(),
  }
}
