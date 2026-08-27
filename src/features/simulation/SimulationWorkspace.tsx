import { useEffect, useReducer, useState } from 'react'
import type { FormEvent } from 'react'
import { heatFlowCapabilities, heatFlowServices } from '../../demo/heatflow/data'
import { createHeatFlowTools } from '../../webmcp/createHeatFlowTools'
import { registerTools } from '../../webmcp/registerTools'
import { ImplementationPack } from '../implementation/ImplementationPack'
import { ReadinessReport } from '../readiness/ReadinessReport'
import {
  checkServiceArea,
  createActivity,
  initialSimulationState,
  searchServices,
  simulationReducer,
  toolCatalogLabel,
} from './simulationModel'
import type { WebMcpStatus } from './simulationModel'
import { waitForVisibleUpdate } from './visibleUpdate'

type SimulationTab = 'simulation' | 'readiness' | 'implementation'

interface SimulationWorkspaceProps {
  onBack: () => void
}

export function SimulationWorkspace({ onBack }: SimulationWorkspaceProps) {
  const [state, dispatch] = useReducer(simulationReducer, initialSimulationState)
  const [tab, setTab] = useState<SimulationTab>('simulation')
  const [webMcpStatus, setWebMcpStatus] = useState<WebMcpStatus>('checking')
  const [registrationError, setRegistrationError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    const tools = createHeatFlowTools({
      search: async (query, serviceIds) => {
        setTab('simulation')
        dispatch({
          type: 'SEARCH',
          query,
          serviceIds,
          activity: createActivity(
            'search_services',
            `Searched services for “${query}” — ${serviceIds.length} match${serviceIds.length === 1 ? '' : 'es'}`,
          ),
        })
        await waitForVisibleUpdate()
      },
      checkArea: async (result) => {
        setTab('simulation')
        dispatch({
          type: 'CHECK_AREA',
          result,
          activity: createActivity('check_service_area', `Checked ${result.serviceLabel.toLowerCase()} availability for ${result.postcode}`),
        })
        await waitForVisibleUpdate()
      },
      compare: async (serviceIds) => {
        setTab('simulation')
        dispatch({
          type: 'COMPARE',
          serviceIds,
          activity: createActivity('compare_services', `Compared ${serviceIds.length} heating solutions`),
        })
        await waitForVisibleUpdate()
      },
      prepareQuote: async (quote) => {
        setTab('simulation')
        dispatch({
          type: 'PREPARE_QUOTE',
          quote,
          activity: createActivity('prepare_quote_request', 'Prepared an editable quote request for review'),
        })
        await waitForVisibleUpdate()
        document.getElementById('quote-request')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      },
      reset: async () => {
        setTab('simulation')
        dispatch({ type: 'RESET', activity: createActivity('reset_simulation', 'Reset the simulation to its initial state') })
        await waitForVisibleUpdate()
      },
    })

    registerTools(tools, { controller })
      .then((result) => {
        if (!active) return
        setWebMcpStatus(result.supported ? 'connected' : 'unavailable')
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return
        setRegistrationError(error instanceof Error ? error.message : 'Tool registration failed.')
        setWebMcpStatus('error')
      })

    return () => {
      active = false
      controller.abort()
    }
  }, [])

  const visibleServices = heatFlowServices.filter((service) => state.visibleServiceIds.includes(service.id))
  const comparedServices = heatFlowServices.filter((service) => state.comparisonIds.includes(service.id))

  function handleHumanSearch(value: string) {
    dispatch({ type: 'SET_SEARCH', query: value, serviceIds: searchServices(value) })
  }

  function handleAreaSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!/^\d{4}$/.test(state.areaPostcode)) return
    dispatch({ type: 'SET_AREA', result: checkServiceArea(state.areaPostcode, state.areaService) })
  }

  function toggleComparison(serviceId: string) {
    const selected = state.comparisonIds.includes(serviceId)
      ? state.comparisonIds.filter((id) => id !== serviceId)
      : [...state.comparisonIds, serviceId].slice(-3)
    dispatch({ type: 'SET_COMPARISON', serviceIds: selected })
  }

  function handleQuoteReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    dispatch({ type: 'MARK_QUOTE_REVIEWED' })
  }

  return (
    <div className="workspace-shell simulator-shell">
      <header className="workspace-header simulator-header">
        <button className="workspace-brand" type="button" onClick={onBack}>
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>WebMCP Simulator</span>
        </button>
        <nav className="simulator-tabs" aria-label="Simulation views">
          <button className={tab === 'simulation' ? 'active' : ''} type="button" onClick={() => setTab('simulation')}>Simulation</button>
          <button className={tab === 'readiness' ? 'active' : ''} type="button" onClick={() => setTab('readiness')}>Readiness report</button>
          <button className={tab === 'implementation' ? 'active' : ''} type="button" onClick={() => setTab('implementation')}>Implementation pack</button>
        </nav>
        <button className="ghost-button" type="button" onClick={onBack}>← Opportunities</button>
      </header>

      <div className="simulation-banner">
        <div><span className="simulation-pulse" /><strong>WebMCP Simulation</strong><span>Original website unchanged</span></div>
        <p>All actions happen locally in this fictional HeatFlow environment.</p>
      </div>

      {tab === 'readiness' && <ReadinessReport onOpenImplementation={() => setTab('implementation')} />}
      {tab === 'implementation' && <ImplementationPack />}
      {tab === 'simulation' && (
        <main className="simulation-layout">
          <section className="heatflow-simulator">
            <header className="heatflow-header">
              <div className="heatflow-wordmark"><span>◒</span><strong>HeatFlow</strong><small>SIMULATED WEBSITE</small></div>
              <nav><a href="#services">Services</a><a href="#service-area">Service area</a><a href="#quote-request">Quote</a></nav>
              <button type="button" onClick={() => document.getElementById('quote-request')?.scrollIntoView({ behavior: 'smooth' })}>Request a quote</button>
            </header>

            <section className="heatflow-hero">
              <div><span>SMART HEATING, CLEAR DECISIONS</span><h1>Comfort that works smarter.</h1><p>Compare modern heating solutions, check coverage, and prepare your consultation — all in one place.</p></div>
              <div className="heat-graphic" aria-hidden="true"><i /><i /><i /><span>21°</span></div>
            </section>

            <section className="service-catalog" id="services">
              <div className="heatflow-section-title"><div><span>OUR SERVICES</span><h2>Find the right heating solution</h2></div><label><span>⌕</span><input type="search" value={state.query} onChange={(event) => handleHumanSearch(event.target.value)} placeholder="Search services" /></label></div>
              {state.query && <div className="filter-result"><span>✦</span> Showing {visibleServices.length} result{visibleServices.length === 1 ? '' : 's'} for “{state.query}” <button type="button" onClick={() => handleHumanSearch('')}>Clear</button></div>}
              <div className="service-grid">
                {heatFlowServices.map((service) => {
                  const visible = state.visibleServiceIds.includes(service.id)
                  const compared = state.comparisonIds.includes(service.id)
                  return (
                    <article className={`service-card ${visible ? 'is-visible' : 'is-dimmed'} service-${service.accent}`} key={service.id}>
                      <div className="service-card-visual"><span>{service.accent === 'mint' ? '≈' : service.accent === 'blue' ? '◫' : service.accent === 'amber' ? '⌁' : '◇'}</span><small>{service.eyebrow}</small></div>
                      <h3>{service.name}</h3><p>{service.description}</p>
                      <div className="service-meta"><span><small>Investment</small><strong>{service.price}</strong></span><span><small>Best for</small><strong>{service.idealFor}</strong></span></div>
                      <button className={compared ? 'comparison-selected' : ''} type="button" onClick={() => toggleComparison(service.id)}>{compared ? '✓ Added to comparison' : '+ Compare'}</button>
                    </article>
                  )
                })}
              </div>
            </section>

            {comparedServices.length >= 2 && (
              <section className="comparison-panel" aria-live="polite">
                <div className="comparison-heading"><div><span>DIRECT COMPARISON</span><h2>{comparedServices.length} solutions side by side</h2></div><button type="button" onClick={() => dispatch({ type: 'SET_COMPARISON', serviceIds: [] })}>Close ×</button></div>
                <div className="comparison-table">
                  <div className="comparison-labels"><span>Solution</span><span>Investment</span><span>Efficiency</span><span>Ideal for</span></div>
                  {comparedServices.map((service) => <div key={service.id}><strong>{service.name}</strong><span>{service.price}</span><span>{service.efficiency}</span><span>{service.idealFor}</span></div>)}
                </div>
              </section>
            )}

            <section className="area-section" id="service-area">
              <div><span className="heatflow-kicker">SERVICE AREA</span><h2>Is HeatFlow available near you?</h2><p>Coverage uses deterministic demo rules. The agent cannot invent availability.</p></div>
              <form onSubmit={handleAreaSubmit}>
                <label>Postcode<input value={state.areaPostcode} onChange={(event) => dispatch({ type: 'SET_AREA_POSTCODE', postcode: event.target.value.replace(/\D/g, '').slice(0, 4) })} inputMode="numeric" /></label>
                <label>Service<select value={state.areaService} onChange={(event) => dispatch({ type: 'SET_AREA_SERVICE', service: event.target.value })}>{heatFlowServices.map((service) => <option value={service.toolValue} key={service.id}>{service.name}</option>)}</select></label>
                <button type="submit">Check area</button>
              </form>
              {state.areaResult && <div className={`area-result result-${state.areaResult.status}`} aria-live="polite"><span>{state.areaResult.status === 'available' ? '✓' : '?'}</span><div><strong>{state.areaResult.status === 'available' ? 'Service available' : 'Manual confirmation needed'}</strong><p>{state.areaResult.message}</p></div></div>}
            </section>

            <section className="quote-section" id="quote-request">
              <div className="quote-copy"><span className="heatflow-kicker">PERSONAL CONSULTATION</span><h2>Prepare your quote request</h2><p>Tell us about the property. Nothing is sent from this simulation.</p><ul><li>✓ Editable before review</li><li>✓ No automatic submission</li><li>✓ Original website untouched</li></ul></div>
              <form className={state.agentPreparedQuote ? 'agent-prepared' : ''} onSubmit={handleQuoteReview}>
                {state.agentPreparedQuote && <div className="prepared-banner"><span>✦</span><div><strong>Prepared by agent</strong><small>Review and edit every field before continuing.</small></div></div>}
                <label>Service<select value={state.quote.service} onChange={(event) => dispatch({ type: 'EDIT_QUOTE', field: 'service', value: event.target.value })}><option value="">Choose a service</option>{heatFlowServices.map((service) => <option value={service.toolValue} key={service.id}>{service.name}</option>)}</select></label>
                <div className="form-row"><label>Postcode<input value={state.quote.postcode} onChange={(event) => dispatch({ type: 'EDIT_QUOTE', field: 'postcode', value: event.target.value })} placeholder="2230" /></label><label>Property size (m²)<input type="number" min="30" max="1000" step="1" value={state.quote.propertySize} onChange={(event) => dispatch({ type: 'EDIT_QUOTE', field: 'propertySize', value: event.target.value })} placeholder="150" /></label></div>
                <label>Message<textarea value={state.quote.message} onChange={(event) => dispatch({ type: 'EDIT_QUOTE', field: 'message', value: event.target.value })} placeholder="What should the advisor know?" maxLength={500} /></label>
                <button type="submit">Review request <span>→</span></button>
                <small className="simulation-submit-note">Simulation only — this button never sends data.</small>
                {state.sendNotice && <div className="not-sent-notice" role="status">✓ Review complete. No request was sent.</div>}
              </form>
            </section>
          </section>

        <aside className="agent-panel" tabIndex={0} aria-label="WebMCP agent activity">
            <div className="agent-panel-header"><div><span className="agent-orb">✦</span><span><strong>Agent activity</strong><small>Real WebMCP tool calls appear here</small></span></div><span className={`webmcp-state state-${webMcpStatus}`}>{webMcpStatus === 'connected' ? 'Connected' : webMcpStatus === 'checking' ? 'Checking' : webMcpStatus === 'unavailable' ? 'Browser unsupported' : 'Registration error'}</span></div>
            {webMcpStatus === 'unavailable' && <div className="support-message"><strong>WebMCP is not exposed in this browser.</strong><p>Open the deployed app in ChatGPT's in-app browser or enable WebMCP testing in compatible Chrome.</p></div>}
            {webMcpStatus === 'error' && <div className="support-message error"><strong>Tools could not be registered.</strong><p>{registrationError}</p></div>}

            <div className="registered-tools">
              <div className="agent-section-label"><span>{toolCatalogLabel(webMcpStatus)}</span><em>{heatFlowCapabilities.length}</em></div>
              {heatFlowCapabilities.map((capability) => <div className="registered-tool" key={capability.id}><span className="tool-mini-icon">⌘</span><span><code>{capability.name}</code><small>{capability.title}</small></span><i className={`impact-dot dot-${capability.impact}`} /></div>)}
            </div>

            <div className="activity-feed">
              <div className="agent-section-label"><span>RECENT ACTIVITY</span><em>{state.activities.length}</em></div>
              {state.activities.length === 0 ? (
                <div className="empty-activity"><span>◎</span><strong>Waiting for an agent</strong><p>Ask a compatible agent to find heat pumps, check postcode 2230, compare two services, or prepare a quote.</p></div>
              ) : state.activities.map((activity) => (
                <div className="activity-item" key={activity.id}><span>✓</span><div><strong>{activity.message}</strong><code>{activity.toolName}</code></div><time>{activity.timestamp}</time></div>
              ))}
            </div>

            <div className="agent-explainer"><span>↯</span><p><strong>Structured, not simulated clicks.</strong>The agent receives explicit capabilities and validated inputs from the page.</p></div>
          </aside>
        </main>
      )}
    </div>
  )
}
