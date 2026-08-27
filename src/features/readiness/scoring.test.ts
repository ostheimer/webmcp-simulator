import { describe, expect, it } from 'vitest'
import { calculateReadiness, scoreOpportunity } from './scoring'

describe('scoreOpportunity', () => {
  it('classifies a structured multi-step workflow as high impact', () => {
    expect(scoreOpportunity({
      multipleSteps: true,
      structuredInput: true,
      changesInterfaceState: true,
      requiresUiInference: true,
      humanConfirmationMatters: true,
      combinesInformation: true,
    })).toEqual({ score: 10, impact: 'high' })
  })

  it('keeps a simple local action low impact', () => {
    expect(scoreOpportunity({
      multipleSteps: false,
      structuredInput: false,
      changesInterfaceState: true,
      requiresUiInference: false,
      humanConfirmationMatters: false,
      combinesInformation: false,
    })).toEqual({ score: 2, impact: 'low' })
  })
})

describe('calculateReadiness', () => {
  it('sums inspectable fixed factors', () => {
    const result = calculateReadiness([
      { id: 'one', label: 'One', current: 10, potential: 20, maximum: 20 },
      { id: 'two', label: 'Two', current: 5, potential: 15, maximum: 20 },
    ])
    expect(result.current).toBe(15)
    expect(result.potential).toBe(35)
  })
})
