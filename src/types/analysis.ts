export type CapabilityCategory =
  | 'search'
  | 'filter'
  | 'form'
  | 'navigation'
  | 'calculator'
  | 'comparison'
  | 'availability'
  | 'contact'
  | 'other'

export type CapabilityImpact = 'low' | 'medium' | 'high'

export interface DetectedSection {
  id: string
  title: string
  evidence: string
}

export interface DetectedForm {
  id: string
  name?: string
  fields: string[]
  evidence: string
}

export interface DetectedLink {
  label: string
  href: string
}

export interface ProposedCapability {
  id: string
  name: string
  title: string
  description: string
  category: CapabilityCategory
  impact: CapabilityImpact
  reason: string
  inputSchema: Record<string, unknown>
  simulatorType: string
}

export interface WebsiteAnalysis {
  url: string
  title?: string
  description?: string
  sections: DetectedSection[]
  forms: DetectedForm[]
  links: DetectedLink[]
  capabilities: ProposedCapability[]
}
