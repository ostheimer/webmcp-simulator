import { describe, expect, it } from 'vitest'
import {
  checkServiceArea,
  createActivity,
  initialSimulationState,
  searchServices,
  simulationReducer,
} from './simulationModel'

describe('HeatFlow simulation rules', () => {
  it('finds both heat-pump services', () => {
    expect(searchServices('heat pump')).toEqual([
      'heat-pump-air',
      'heat-pump-ground',
    ])
  })

  it('returns deterministic availability for the demo postcode', () => {
    expect(checkServiceArea('2230', 'heat_pump')).toMatchObject({
      status: 'available',
      postcode: '2230',
    })
  })

  it('uses manual confirmation outside deterministic coverage', () => {
    expect(checkServiceArea('9020', 'ground_heat_pump').status).toBe('manual')
  })
})

describe('simulationReducer', () => {
  it('adds agent activity with a visible search state', () => {
    const activity = createActivity('search_services', 'Searched heat pumps')
    const state = simulationReducer(initialSimulationState, {
      type: 'SEARCH',
      query: 'heat pump',
      serviceIds: ['heat-pump-air', 'heat-pump-ground'],
      activity,
    })
    expect(state.query).toBe('heat pump')
    expect(state.activities[0]).toBe(activity)
  })

  it('resets prepared data while retaining the reset event', () => {
    const resetActivity = createActivity('reset_simulation', 'Reset')
    const state = simulationReducer(
      { ...initialSimulationState, query: 'heat pump', agentPreparedQuote: true },
      { type: 'RESET', activity: resetActivity },
    )
    expect(state.query).toBe('')
    expect(state.agentPreparedQuote).toBe(false)
    expect(state.activities).toEqual([resetActivity])
  })
})
