import type { ProposedCapability, WebsiteAnalysis } from '../../types/analysis'
import {
  calculateReadiness,
  scoreOpportunity,
  type OpportunitySignals,
  type ReadinessFactor,
} from '../../features/readiness/scoring'

export interface HeatFlowService {
  id: string
  toolValue: string
  name: string
  eyebrow: string
  description: string
  price: string
  efficiency: string
  idealFor: string
  accent: 'amber' | 'mint' | 'blue' | 'violet'
  tags: string[]
}

export const heatFlowServices: HeatFlowService[] = [
  {
    id: 'heat-pump-air',
    toolValue: 'heat_pump',
    name: 'Air-source heat pump',
    eyebrow: 'Most popular',
    description: 'Efficient all-season heating with a compact outdoor unit.',
    price: 'from €14,900',
    efficiency: 'Up to 420%',
    idealFor: 'Modernization',
    accent: 'mint',
    tags: ['heat pump', 'electric', 'renovation', 'air'],
  },
  {
    id: 'heat-pump-ground',
    toolValue: 'ground_heat_pump',
    name: 'Ground-source heat pump',
    eyebrow: 'Maximum efficiency',
    description: 'Stable performance using energy stored below the property.',
    price: 'from €24,500',
    efficiency: 'Up to 500%',
    idealFor: 'New builds',
    accent: 'blue',
    tags: ['heat pump', 'ground', 'geothermal', 'new build'],
  },
  {
    id: 'gas-hybrid',
    toolValue: 'hybrid_heating',
    name: 'Hybrid heating',
    eyebrow: 'Flexible upgrade',
    description: 'Combine an existing boiler with renewable heat-pump power.',
    price: 'from €10,800',
    efficiency: 'Up to 135%',
    idealFor: 'Phased upgrades',
    accent: 'amber',
    tags: ['gas', 'hybrid', 'boiler', 'upgrade'],
  },
  {
    id: 'maintenance-care',
    toolValue: 'maintenance',
    name: 'Maintenance care',
    eyebrow: 'Long-term support',
    description: 'Annual inspection, optimization, and priority assistance.',
    price: 'from €249/year',
    efficiency: 'System care',
    idealFor: 'Existing systems',
    accent: 'violet',
    tags: ['maintenance', 'service', 'support', 'inspection'],
  },
]

function capability(
  definition: Omit<ProposedCapability, 'impact'>,
  signals: OpportunitySignals,
): ProposedCapability {
  return {
    ...definition,
    impact: scoreOpportunity(signals).impact,
  }
}

export const heatFlowCapabilities: ProposedCapability[] = [
  capability(
    {
      id: 'search-services',
      name: 'search_services',
      title: 'Search services',
      description:
        'Search and focus the service catalog using a natural-language query.',
      category: 'search',
      reason:
        'An agent otherwise has to interpret navigation, cards, and terminology across several sections.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            maxLength: 80,
            description: 'Service need or heating technology to look for.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      simulatorType: 'service-search',
    },
    {
      multipleSteps: true,
      structuredInput: true,
      changesInterfaceState: true,
      requiresUiInference: true,
      humanConfirmationMatters: false,
      combinesInformation: false,
    },
  ),
  capability(
    {
      id: 'check-service-area',
      name: 'check_service_area',
      title: 'Check service area',
      description:
        'Check deterministic installation availability for a postcode and service.',
      category: 'availability',
      reason:
        'Availability depends on two inputs and should come from explicit business rules, not model inference.',
      inputSchema: {
        type: 'object',
        properties: {
          postcode: {
            type: 'string',
            pattern: '^\\d{4}$',
            description: 'Four-digit Austrian postcode.',
          },
          service: {
            type: 'string',
            enum: ['heat_pump', 'ground_heat_pump', 'hybrid_heating', 'maintenance'],
          },
        },
        required: ['postcode', 'service'],
        additionalProperties: false,
      },
      simulatorType: 'service-area',
    },
    {
      multipleSteps: true,
      structuredInput: true,
      changesInterfaceState: true,
      requiresUiInference: true,
      humanConfirmationMatters: false,
      combinesInformation: true,
    },
  ),
  capability(
    {
      id: 'compare-services',
      name: 'compare_services',
      title: 'Compare services',
      description:
        'Open a focused comparison of two or three heating solutions.',
      category: 'comparison',
      reason:
        'The current site distributes price, efficiency, and suitability across separate service cards.',
      inputSchema: {
        type: 'object',
        properties: {
          serviceIds: {
            type: 'array',
            items: {
              type: 'string',
              enum: heatFlowServices.map((service) => service.id),
            },
            minItems: 2,
            maxItems: 3,
            uniqueItems: true,
          },
        },
        required: ['serviceIds'],
        additionalProperties: false,
      },
      simulatorType: 'comparison',
    },
    {
      multipleSteps: true,
      structuredInput: true,
      changesInterfaceState: true,
      requiresUiInference: true,
      humanConfirmationMatters: false,
      combinesInformation: true,
    },
  ),
  capability(
    {
      id: 'prepare-quote-request',
      name: 'prepare_quote_request',
      title: 'Prepare quote request',
      description:
        'Populate an editable quote request for human review without submitting it.',
      category: 'form',
      reason:
        'The workflow combines several fields and must preserve a clear human confirmation boundary.',
      inputSchema: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            enum: ['heat_pump', 'ground_heat_pump', 'hybrid_heating', 'maintenance'],
          },
          postcode: { type: 'string', pattern: '^\\d{4}$' },
          propertySize: { type: 'integer', minimum: 30, maximum: 1000 },
          message: { type: 'string', maxLength: 500 },
        },
        required: ['service', 'postcode', 'propertySize'],
        additionalProperties: false,
      },
      simulatorType: 'quote-preparation',
    },
    {
      multipleSteps: true,
      structuredInput: true,
      changesInterfaceState: true,
      requiresUiInference: true,
      humanConfirmationMatters: true,
      combinesInformation: true,
    },
  ),
  capability(
    {
      id: 'reset-simulation',
      name: 'reset_simulation',
      title: 'Reset simulation',
      description: 'Restore the HeatFlow simulation to its initial local state.',
      category: 'other',
      reason:
        'A deterministic reset makes repeated demos and agent evaluation reliable.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      simulatorType: 'reset',
    },
    {
      multipleSteps: false,
      structuredInput: false,
      changesInterfaceState: true,
      requiresUiInference: false,
      humanConfirmationMatters: false,
      combinesInformation: false,
    },
  ),
]

export const heatFlowAnalysis: WebsiteAnalysis = {
  url: 'https://heatflow.example',
  title: 'HeatFlow — Smart heating for every home',
  description:
    'Fictional heating specialist with heat pumps, hybrid heating, maintenance, service-area checks, and quote requests.',
  sections: [
    { id: 'services', title: 'Heating services', evidence: 'Four visible service cards' },
    { id: 'area', title: 'Service area', evidence: 'Postcode availability checker' },
    { id: 'pricing', title: 'Pricing', evidence: 'Starting-price information per service' },
    { id: 'contact', title: 'Quote request', evidence: 'Multi-field consultation form' },
  ],
  forms: [
    {
      id: 'service-area-form',
      name: 'Service area check',
      fields: ['postcode', 'service'],
      evidence: 'Visible availability form',
    },
    {
      id: 'quote-request-form',
      name: 'Quote request',
      fields: ['service', 'postcode', 'propertySize', 'message'],
      evidence: 'Visible consultation form',
    },
  ],
  links: [
    { label: 'Services', href: '#services' },
    { label: 'Service area', href: '#service-area' },
    { label: 'Request a quote', href: '#quote' },
  ],
  capabilities: heatFlowCapabilities,
}

const readinessFactors: ReadinessFactor[] = [
  { id: 'semantics', label: 'Semantic structure', current: 8, potential: 12, maximum: 15 },
  { id: 'inputs', label: 'Structured inputs', current: 6, potential: 18, maximum: 20 },
  { id: 'capabilities', label: 'Explicit capabilities', current: 0, potential: 30, maximum: 30 },
  { id: 'safety', label: 'Action boundaries', current: 8, potential: 14, maximum: 15 },
  { id: 'state', label: 'Observable state', current: 10, potential: 14, maximum: 20 },
]

export const heatFlowReadiness = calculateReadiness(readinessFactors)
