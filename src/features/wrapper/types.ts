export type WrapperInteractionKind = 'prepare_search' | 'filter' | 'prepare_form' | 'navigation'

export interface WrapperDomEvidence {
  id: string
  tag: 'a' | 'input' | 'select' | 'textarea'
  type: string
  role: string
  label: string
  selector: string
  fieldKey?: string
  formId?: string
  optionCount?: number
  sensitive: boolean
}

export interface WrapperAxEvidence {
  role: string
  name: string
}

export interface WrapperCapability {
  id: string
  name: string
  title: string
  description: string
  kind: WrapperInteractionKind
  inputSchema: Record<string, unknown>
  evidenceIds: string[]
  sampleInput: Record<string, unknown>
}

export interface WrapperAnalysis {
  sessionId: string
  sessionToken: string
  requestedUrl: string
  finalUrl: string
  title: string
  screenshotDataUrl: string
  domEvidence: WrapperDomEvidence[]
  axEvidence: WrapperAxEvidence[]
  capabilities: WrapperCapability[]
  warnings: string[]
  blockedRequests: number
  analyzedPages: number
  maxPages: number
  expiresAt: string
  runtime: {
    provider: 'local-playwright' | 'vercel-sandbox'
    runtimeMs: number
    vcpus: number
    memoryMb: number
    allowedNetworkRequests: number
    blockedNetworkRequests: number
    ingressBytes?: number
    egressBytes?: number
    estimatedCost: {
      currency: 'USD'
      lowerBound: number
      upperBound: number
      basis: 'illustrative-list-price'
    }
  }
  createdAt: string
}

export interface WrapperActivity {
  id: string
  toolName: string
  summary: string
  createdAt: string
}

export interface WrapperActionResult {
  finalUrl: string
  screenshotDataUrl: string
  analysis: WrapperAnalysis
  activity: WrapperActivity
  structuredContent: {
    toolName: string
    actionKind: WrapperInteractionKind
    finalUrl: string
    isolatedStateChanged: true
    targetStateVerified: true
    networkPolicy: 'blocked-after-preparation' | 'same-origin-navigation'
    blockedNetworkRequests: number
    allowedNetworkRequests: number
    formSubmissionPrevented: true
    navigationOccurred: boolean
  }
}
