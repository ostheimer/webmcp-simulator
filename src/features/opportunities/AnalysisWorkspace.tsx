import { useState } from 'react'
import type { AnalysisAttempt } from '../analysis/analyzer'
import type { ProposedCapability } from '../../types/analysis'

interface AnalysisWorkspaceProps {
  attempt: AnalysisAttempt
  onBack: () => void
  onLaunch: () => void
  onDemo: () => void
}

function ImpactBadge({ impact }: { impact: ProposedCapability['impact'] }) {
  return <span className={`impact-label impact-${impact}`}>{impact.toUpperCase()}</span>
}

function OpportunityCard({ capability }: { capability: ProposedCapability }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <article className={`opportunity-card ${expanded ? 'is-expanded' : ''}`}>
      <button className="opportunity-summary" type="button" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
        <span className="opportunity-icon" aria-hidden="true">✦</span>
        <span className="opportunity-title-group">
          <code>{capability.name}</code>
          <span>{capability.title}</span>
        </span>
        <ImpactBadge impact={capability.impact} />
        <span className="expand-glyph" aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      <p>{capability.description}</p>
      {expanded && (
        <div className="opportunity-details">
          <div>
            <span className="detail-label">WHY WEBMCP HELPS</span>
            <p>{capability.reason}</p>
          </div>
          <div className="interaction-compare">
            <div><span className="detail-label">WEBSITE TODAY</span><p>Agent navigates, identifies controls, and infers how the fields relate.</p></div>
            <div><span className="detail-label">WITH WEBMCP</span><p>Agent calls one named capability with explicit, validated inputs.</p></div>
          </div>
          <div>
            <span className="detail-label">PROPOSED INPUT SCHEMA</span>
            <pre>{JSON.stringify(capability.inputSchema, null, 2)}</pre>
          </div>
        </div>
      )}
    </article>
  )
}

export function AnalysisWorkspace({
  attempt,
  onBack,
  onLaunch,
  onDemo,
}: AnalysisWorkspaceProps) {
  const { analysis, limited, limitation } = attempt

  return (
    <div className="workspace-shell analysis-shell">
      <header className="workspace-header">
        <button className="workspace-brand" type="button" onClick={onBack}>
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>WebMCP Simulator</span>
        </button>
        <div className="workspace-context"><span className="context-dot" />Analysis complete</div>
        <button className="ghost-button" type="button" onClick={onBack}>New analysis</button>
      </header>

      <div className="analysis-heading">
        <div>
          <p className="workspace-kicker">WEBSITE ANALYSIS</p>
          <h1>Potential capabilities, made visible.</h1>
          <p>Based on this website, we found these potential WebMCP capabilities. They are proposals, not claims about the original site.</p>
        </div>
        {!limited && <div className="analysis-count"><strong>{analysis.capabilities.length}</strong><span>potential tools</span></div>}
      </div>

      {limited ? (
        <main className="limited-analysis">
          <section className="limited-card">
            <div className="limited-icon" aria-hidden="true">⌁</div>
            <p className="workspace-kicker">OBSERVED URL</p>
            <h2>{analysis.title}</h2>
            <a href={analysis.url} target="_blank" rel="noreferrer">{analysis.url}</a>
            <p>{limitation}</p>
            <div className="evidence-note"><strong>Evidence retained:</strong> URL only. No forms, actions, or availability rules were fabricated.</div>
            <button className="primary-button" type="button" onClick={onDemo}>Experience the HeatFlow demo <span>→</span></button>
          </section>
        </main>
      ) : (
        <main className="analysis-grid">
          <section className="analysis-preview-panel">
            <div className="panel-heading-row"><div><span className="workspace-kicker">WEBSITE PREVIEW</span><h2>{analysis.title}</h2></div><span className="simulation-chip">Reconstructed preview</span></div>
            <div className="analysis-browser">
              <div className="browser-bar">
                <div className="browser-dots"><span /><span /><span /></div>
                <div className="browser-url">◇ {analysis.url}</div>
                <span className="browser-menu">•••</span>
              </div>
              <div className="heatflow-page-preview">
                <div className="hf-preview-nav"><strong><span>◒</span> HeatFlow</strong><div><span>Services</span><span>Service area</span><span>Pricing</span><span>Contact</span></div><button type="button">Get a quote</button></div>
                <div className="hf-preview-hero"><span>COMFORT, MADE EFFICIENT</span><h3>Smart heating for every home.</h3><p>Expert installation and care for modern heating systems.</p></div>
                <div className="hf-preview-grid"><article><i className="service-visual mint" /><b>Air-source heat pump</b><small>Efficient modernization</small></article><article><i className="service-visual blue" /><b>Ground-source heat pump</b><small>Maximum efficiency</small></article><article><i className="service-visual amber" /><b>Hybrid heating</b><small>Flexible upgrade</small></article></div>
                <div className="analysis-marker marker-services"><span>✦</span><div><strong>search_services</strong><small>Catalog search opportunity</small></div></div>
                <div className="analysis-marker marker-area"><span>✦</span><div><strong>check_service_area</strong><small>Availability opportunity</small></div></div>
                <div className="analysis-marker marker-quote"><span>✦</span><div><strong>prepare_quote_request</strong><small>Safe form preparation</small></div></div>
              </div>
            </div>
            <div className="detected-evidence">
              {analysis.sections.map((section) => (
                <div key={section.id}><span className="evidence-check">✓</span><span><strong>{section.title}</strong><small>{section.evidence}</small></span></div>
              ))}
            </div>
          </section>

          <aside className="opportunities-panel">
            <div className="panel-heading-row"><div><span className="workspace-kicker">PROPOSED TOOLS</span><h2>WebMCP Opportunities</h2></div><span className="proposal-badge">Inferred</span></div>
            <div className="opportunity-list">
              {analysis.capabilities.map((capability) => <OpportunityCard capability={capability} key={capability.id} />)}
            </div>
            <div className="launch-panel">
              <div><span className="launch-spark">✦</span><span><strong>Ready to experience it?</strong><small>Launch a safe, WebMCP-enabled simulation.</small></span></div>
              <button className="primary-button" type="button" onClick={onLaunch}>Launch simulation <span>→</span></button>
              <p>No actions are performed on the original website.</p>
            </div>
          </aside>
        </main>
      )}
    </div>
  )
}
