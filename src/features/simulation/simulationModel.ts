import { heatFlowServices } from '../../demo/heatflow/data'

export type AreaStatus = 'available' | 'manual'

export interface ServiceAreaResult {
  postcode: string
  service: string
  serviceLabel: string
  status: AreaStatus
  message: string
}

export interface QuoteDraft {
  service: string
  postcode: string
  propertySize: string
  message: string
}

export interface AgentActivity {
  id: string
  toolName: string
  message: string
  timestamp: string
}

export type AgentHighlightSection =
  | 'services'
  | 'service-comparison'
  | 'service-area'
  | 'quote-request'
  | 'agent-activity'

/**
 * Transient, wrapper-owned emphasis on the part of the page an agent call just
 * changed. Human interactions never create one; they clear it instead, so the
 * emphasis can only ever point at a real WebMCP tool invocation.
 */
export interface AgentHighlight {
  /** Equals the activity ID so a stale timeout cannot clear a newer highlight. */
  id: string
  toolName: string
  /** The activity message, i.e. what the call changed, in wrapper-owned words. */
  message: string
  sectionId: AgentHighlightSection
  /** Wrapper-owned keys of the fields or cards the call populated. */
  fields: string[]
}

/**
 * How long the agent highlight stays visible before it clears itself. Long
 * enough for a viewer who is reading the agent's chat at the same time; the
 * next agent call or any human interaction clears it earlier.
 */
export const agentHighlightDurationMs = 20000

export interface SimulationState {
  query: string
  visibleServiceIds: string[]
  areaPostcode: string
  areaService: string
  areaResult: ServiceAreaResult | null
  comparisonIds: string[]
  quote: QuoteDraft
  agentPreparedQuote: boolean
  sendNotice: boolean
  activities: AgentActivity[]
  agentHighlight: AgentHighlight | null
}

export type SimulationAction =
  | { type: 'SEARCH'; query: string; serviceIds: string[]; activity: AgentActivity }
  | { type: 'SET_SEARCH'; query: string; serviceIds: string[] }
  | { type: 'CHECK_AREA'; result: ServiceAreaResult; activity: AgentActivity }
  | { type: 'SET_AREA'; result: ServiceAreaResult }
  | { type: 'SET_AREA_POSTCODE'; postcode: string }
  | { type: 'SET_AREA_SERVICE'; service: string }
  | { type: 'COMPARE'; serviceIds: string[]; activity: AgentActivity }
  | { type: 'SET_COMPARISON'; serviceIds: string[] }
  | { type: 'PREPARE_QUOTE'; quote: QuoteDraft; activity: AgentActivity }
  | { type: 'EDIT_QUOTE'; field: keyof QuoteDraft; value: string }
  | { type: 'MARK_QUOTE_REVIEWED' }
  | { type: 'RESET'; activity?: AgentActivity }
  | { type: 'CLEAR_AGENT_HIGHLIGHT'; id: string }

export const initialQuote: QuoteDraft = {
  service: '',
  postcode: '',
  propertySize: '',
  message: '',
}

export const initialSimulationState: SimulationState = {
  query: '',
  visibleServiceIds: heatFlowServices.map((service) => service.id),
  areaPostcode: '2230',
  areaService: 'heat_pump',
  areaResult: null,
  comparisonIds: [],
  quote: initialQuote,
  agentPreparedQuote: false,
  sendNotice: false,
  activities: [],
  agentHighlight: null,
}

function highlightFrom(
  activity: AgentActivity,
  sectionId: AgentHighlightSection,
  fields: string[],
): AgentHighlight {
  return { id: activity.id, toolName: activity.toolName, message: activity.message, sectionId, fields }
}

export function simulationReducer(
  state: SimulationState,
  action: SimulationAction,
): SimulationState {
  switch (action.type) {
    case 'SEARCH':
      return {
        ...state,
        query: action.query,
        visibleServiceIds: action.serviceIds,
        activities: [action.activity, ...state.activities],
        agentHighlight: highlightFrom(action.activity, 'services', ['query']),
      }
    case 'SET_SEARCH':
      return {
        ...state,
        query: action.query,
        visibleServiceIds: action.serviceIds,
        agentHighlight: null,
      }
    case 'CHECK_AREA':
      return {
        ...state,
        areaPostcode: action.result.postcode,
        areaService: action.result.service,
        areaResult: action.result,
        activities: [action.activity, ...state.activities],
        agentHighlight: highlightFrom(action.activity, 'service-area', ['areaPostcode', 'areaService']),
      }
    case 'SET_AREA':
      return {
        ...state,
        areaPostcode: action.result.postcode,
        areaService: action.result.service,
        areaResult: action.result,
        agentHighlight: null,
      }
    case 'SET_AREA_POSTCODE':
      return { ...state, areaPostcode: action.postcode, areaResult: null, agentHighlight: null }
    case 'SET_AREA_SERVICE':
      return { ...state, areaService: action.service, areaResult: null, agentHighlight: null }
    case 'COMPARE':
      return {
        ...state,
        comparisonIds: action.serviceIds,
        activities: [action.activity, ...state.activities],
        agentHighlight: highlightFrom(action.activity, 'service-comparison', action.serviceIds),
      }
    case 'SET_COMPARISON':
      return {
        ...state,
        comparisonIds: action.serviceIds,
        agentHighlight: null,
      }
    case 'PREPARE_QUOTE':
      return {
        ...state,
        quote: action.quote,
        agentPreparedQuote: true,
        sendNotice: false,
        activities: [action.activity, ...state.activities],
        agentHighlight: highlightFrom(
          action.activity,
          'quote-request',
          ['service', 'postcode', 'propertySize', ...(action.quote.message ? ['message'] : [])],
        ),
      }
    case 'EDIT_QUOTE':
      return {
        ...state,
        quote: { ...state.quote, [action.field]: action.value },
        sendNotice: false,
        agentHighlight: null,
      }
    case 'MARK_QUOTE_REVIEWED':
      return { ...state, sendNotice: true, agentHighlight: null }
    case 'RESET':
      return {
        ...initialSimulationState,
        activities: action.activity ? [action.activity] : [],
        agentHighlight: action.activity ? highlightFrom(action.activity, 'agent-activity', []) : null,
      }
    case 'CLEAR_AGENT_HIGHLIGHT':
      return state.agentHighlight?.id === action.id
        ? { ...state, agentHighlight: null }
        : state
  }
}

export function searchServices(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return heatFlowServices.map((service) => service.id)

  const ignoredWords = new Set([
    'a', 'an', 'find', 'for', 'i', 'me', 'need', 'option', 'please', 'search',
    'service', 'show', 'some', 'the', 'to', 'want', 'with',
  ])
  const normalizeTerm = (term: string) => term.length > 3 && term.endsWith('s')
    ? term.slice(0, -1)
    : term
  const queryTerms = (normalized.match(/[\p{L}\p{N}]+/gu) ?? [])
    .map(normalizeTerm)
    .filter((term) => !ignoredWords.has(term))

  if (queryTerms.length === 0) return heatFlowServices.map((service) => service.id)

  return heatFlowServices
    .filter((service) => {
      const serviceTerms = new Set(
        [service.name, service.eyebrow, service.idealFor, ...service.tags]
          .join(' ')
          .toLowerCase()
          .match(/[\p{L}\p{N}]+/gu)
          ?.map(normalizeTerm) ?? [],
      )
      return queryTerms.every((term) => serviceTerms.has(term))
    })
    .map((service) => service.id)
}

export function isValidQuoteDraft(quote: QuoteDraft): boolean {
  const propertySize = Number(quote.propertySize)
  return heatFlowServices.some((service) => service.toolValue === quote.service)
    && /^\d{4}$/.test(quote.postcode)
    && Number.isInteger(propertySize)
    && propertySize >= 30
    && propertySize <= 1000
    && Array.from(quote.message).length <= 500
}

export function limitCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('')
}

export type WebMcpStatus = 'checking' | 'connected' | 'unavailable' | 'error'

export function toolCatalogLabel(status: WebMcpStatus): string {
  return status === 'connected' ? 'AVAILABLE SITE TOOLS' : 'PROPOSED SITE TOOLS'
}

export function checkServiceArea(
  postcode: string,
  serviceValue: string,
): ServiceAreaResult {
  const service = heatFlowServices.find(
    (candidate) => candidate.toolValue === serviceValue,
  )

  if (!service) throw new Error('Choose a supported HeatFlow service.')

  const prefix = Number(postcode[0])
  const lastDigit = Number(postcode[postcode.length - 1])
  const available =
    serviceValue === 'maintenance'
      ? prefix >= 1 && prefix <= 8
      : serviceValue === 'ground_heat_pump'
        ? prefix >= 1 && prefix <= 4 && lastDigit % 2 === 0
        : prefix >= 1 && prefix <= 4

  return {
    postcode,
    service: serviceValue,
    serviceLabel: service.name,
    status: available ? 'available' : 'manual',
    message: available
      ? `${service.name} is available in ${postcode}.`
      : `Coverage for ${postcode} requires manual confirmation.`,
  }
}

export function createActivity(
  toolName: string,
  message: string,
): AgentActivity {
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${toolName}`,
    toolName,
    message,
    timestamp: new Intl.DateTimeFormat('en', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date()),
  }
}
