import type { CapabilityImpact, ProposedCapability } from '../../types/analysis'

export interface OpportunitySignals {
  multipleSteps: boolean
  structuredInput: boolean
  changesInterfaceState: boolean
  requiresUiInference: boolean
  humanConfirmationMatters: boolean
  combinesInformation: boolean
}

export interface ReadinessFactor {
  id: string
  label: string
  current: number
  potential: number
  maximum: number
}

export interface ReadinessScore {
  current: number
  potential: number
  factors: ReadinessFactor[]
  methodology: string
}

const signalWeights: Record<keyof OpportunitySignals, number> = {
  multipleSteps: 2,
  structuredInput: 2,
  changesInterfaceState: 2,
  requiresUiInference: 2,
  humanConfirmationMatters: 1,
  combinesInformation: 1,
}

export function scoreOpportunity(signals: OpportunitySignals): {
  score: number
  impact: CapabilityImpact
} {
  const score = (Object.keys(signalWeights) as Array<keyof OpportunitySignals>)
    .reduce((total, key) => total + (signals[key] ? signalWeights[key] : 0), 0)

  if (score >= 7) return { score, impact: 'high' }
  if (score >= 4) return { score, impact: 'medium' }
  return { score, impact: 'low' }
}

export function calculateReadiness(factors: ReadinessFactor[]): ReadinessScore {
  const current = factors.reduce((total, factor) => total + factor.current, 0)
  const potential = factors.reduce((total, factor) => total + factor.potential, 0)

  return {
    current,
    potential,
    factors,
    methodology:
      'Illustrative heuristic: five observable integration qualities are scored with fixed weights. It is a decision aid, not a scientific benchmark.',
  }
}

export function countImpact(
  capabilities: ProposedCapability[],
  impact: CapabilityImpact,
): number {
  return capabilities.filter((capability) => capability.impact === impact).length
}
