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

export interface SimulationState {
  query: string
  visibleServiceIds: string[]
  areaResult: ServiceAreaResult | null
  comparisonIds: string[]
  quote: QuoteDraft
  agentPreparedQuote: boolean
  activities: AgentActivity[]
}

export type SimulationAction =
  | { type: 'SEARCH'; query: string; serviceIds: string[]; activity: AgentActivity }
  | { type: 'SET_SEARCH'; query: string; serviceIds: string[] }
  | { type: 'CHECK_AREA'; result: ServiceAreaResult; activity: AgentActivity }
  | { type: 'SET_AREA'; result: ServiceAreaResult }
  | { type: 'COMPARE'; serviceIds: string[]; activity: AgentActivity }
  | { type: 'SET_COMPARISON'; serviceIds: string[] }
  | { type: 'PREPARE_QUOTE'; quote: QuoteDraft; activity: AgentActivity }
  | { type: 'EDIT_QUOTE'; field: keyof QuoteDraft; value: string }
  | { type: 'RESET'; activity?: AgentActivity }

export const initialQuote: QuoteDraft = {
  service: '',
  postcode: '',
  propertySize: '',
  message: '',
}

export const initialSimulationState: SimulationState = {
  query: '',
  visibleServiceIds: heatFlowServices.map((service) => service.id),
  areaResult: null,
  comparisonIds: [],
  quote: initialQuote,
  agentPreparedQuote: false,
  activities: [],
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
      }
    case 'SET_SEARCH':
      return {
        ...state,
        query: action.query,
        visibleServiceIds: action.serviceIds,
      }
    case 'CHECK_AREA':
      return {
        ...state,
        areaResult: action.result,
        activities: [action.activity, ...state.activities],
      }
    case 'SET_AREA':
      return {
        ...state,
        areaResult: action.result,
      }
    case 'COMPARE':
      return {
        ...state,
        comparisonIds: action.serviceIds,
        activities: [action.activity, ...state.activities],
      }
    case 'SET_COMPARISON':
      return {
        ...state,
        comparisonIds: action.serviceIds,
      }
    case 'PREPARE_QUOTE':
      return {
        ...state,
        quote: action.quote,
        agentPreparedQuote: true,
        activities: [action.activity, ...state.activities],
      }
    case 'EDIT_QUOTE':
      return {
        ...state,
        quote: { ...state.quote, [action.field]: action.value },
      }
    case 'RESET':
      return {
        ...initialSimulationState,
        activities: action.activity ? [action.activity] : [],
      }
  }
}

export function searchServices(query: string): string[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return heatFlowServices.map((service) => service.id)

  return heatFlowServices
    .filter((service) =>
      [service.name, service.description, service.eyebrow, ...service.tags]
        .join(' ')
        .toLowerCase()
        .includes(normalized),
    )
    .map((service) => service.id)
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
