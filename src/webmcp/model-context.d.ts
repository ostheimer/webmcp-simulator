type WebMcpToolDefinition = import('./registerTools').WebMcpTool

interface ModelContextRegisterOptions {
  signal?: AbortSignal
  exposedTo?: string[]
}

interface ModelContext {
  registerTool(
    tool: WebMcpToolDefinition,
    options?: ModelContextRegisterOptions,
  ): Promise<void>
}

interface Document {
  readonly modelContext?: ModelContext
}
