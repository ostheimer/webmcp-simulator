import { describe, expect, it } from 'vitest'
import {
  checkServiceArea,
  createActivity,
  initialSimulationState,
  searchServices,
  simulationReducer,
  toolCatalogLabel,
} from './simulationModel'

describe('HeatFlow simulation rules', () => {
  it('finds both heat-pump services', () => {
    expect(searchServices('heat pump')).toEqual([
      'heat-pump-air',
      'heat-pump-ground',
    ])
  })

  it.each([
    ['show me heat pumps', ['heat-pump-air', 'heat-pump-ground']],
    ['I need maintenance', ['maintenance-care']],
    ['please show ground heat pumps', ['heat-pump-ground']],
  ])('matches the natural-language query %s', (query, expected) => {
    expect(searchServices(query)).toEqual(expected)
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
      {
        ...initialSimulationState,
        query: 'heat pump',
        agentPreparedQuote: true,
        areaPostcode: '1010',
        areaService: 'ground_heat_pump',
        sendNotice: true,
      },
      { type: 'RESET', activity: resetActivity },
    )
    expect(state.query).toBe('')
    expect(state.agentPreparedQuote).toBe(false)
    expect(state.areaPostcode).toBe('2230')
    expect(state.areaService).toBe('heat_pump')
    expect(state.sendNotice).toBe(false)
    expect(state.activities).toEqual([resetActivity])
  })

  it('synchronizes an agent area result with the controlled form fields', () => {
    const result = checkServiceArea('1010', 'ground_heat_pump')
    const state = simulationReducer(initialSimulationState, {
      type: 'CHECK_AREA',
      result,
      activity: createActivity('check_service_area', 'Checked area'),
    })
    expect(state.areaPostcode).toBe('1010')
    expect(state.areaService).toBe('ground_heat_pump')
    expect(state.areaResult).toBe(result)
  })

  it('requires a fresh human review after an agent prepares a new quote', () => {
    const reviewed = simulationReducer(initialSimulationState, {
      type: 'MARK_QUOTE_REVIEWED',
    })
    const state = simulationReducer(reviewed, {
      type: 'PREPARE_QUOTE',
      quote: {
        service: 'heat_pump',
        postcode: '2230',
        propertySize: '150',
        message: 'New draft',
      },
      activity: createActivity('prepare_quote_request', 'Prepared quote'),
    })
    expect(state.sendNotice).toBe(false)
    expect(state.agentPreparedQuote).toBe(true)
  })
})

describe('tool catalog presentation', () => {
  it('labels tools as available only after successful registration', () => {
    expect(toolCatalogLabel('connected')).toBe('AVAILABLE SITE TOOLS')
    expect(toolCatalogLabel('checking')).toBe('PROPOSED SITE TOOLS')
    expect(toolCatalogLabel('unavailable')).toBe('PROPOSED SITE TOOLS')
    expect(toolCatalogLabel('error')).toBe('PROPOSED SITE TOOLS')
  })
})
