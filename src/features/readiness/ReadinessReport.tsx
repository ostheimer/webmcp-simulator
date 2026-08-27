import { heatFlowCapabilities, heatFlowReadiness } from '../../demo/heatflow/data'
import type { CSSProperties } from 'react'

interface ReadinessReportProps {
  onOpenImplementation: () => void
}

function ScoreRing({ score, variant }: { score: number; variant: 'current' | 'potential' }) {
  return (
    <div className={`score-ring score-ring-${variant}`} style={{ '--score': score } as CSSProperties}>
      <div><strong>{score}</strong><span>/ 100</span></div>
    </div>
  )
}

export function ReadinessReport({ onOpenImplementation }: ReadinessReportProps) {
  return (
    <section className="report-view">
      <div className="report-intro">
        <p className="workspace-kicker">AGENT READINESS REPORT</p>
        <h2>From interface guessing to explicit capabilities.</h2>
        <p>This illustrative score uses a transparent, deterministic heuristic. It explains direction and opportunity — not scientific precision.</p>
      </div>

      <div className="readiness-comparison">
        <article className="readiness-card current-card">
          <div className="readiness-card-title"><div><span>WEBSITE TODAY</span><h3>Agent interprets the interface</h3></div><ScoreRing score={heatFlowReadiness.current} variant="current" /></div>
          <ul>
            <li><span>01</span>Discover navigation and service terminology</li>
            <li><span>02</span>Interpret cards, forms, and field relationships</li>
            <li><span>03</span>Infer availability and safety boundaries</li>
            <li><span>04</span>Repeat visual actuation across several steps</li>
          </ul>
        </article>
        <div className="comparison-arrow" aria-hidden="true">→</div>
        <article className="readiness-card potential-card">
          <div className="readiness-card-title"><div><span>POTENTIAL WITH WEBMCP</span><h3>Agent receives explicit tools</h3></div><ScoreRing score={heatFlowReadiness.potential} variant="potential" /></div>
          <div className="readiness-tools">
            {heatFlowCapabilities.map((capability) => <code key={capability.id}><span>✓</span>{capability.name}</code>)}
          </div>
        </article>
      </div>

      <div className="factor-panel">
        <div className="factor-header"><div><span className="workspace-kicker">SCORING METHOD</span><h3>Inspect the heuristic</h3></div><p>{heatFlowReadiness.methodology}</p></div>
        <div className="factor-list">
          {heatFlowReadiness.factors.map((factor) => (
            <div className="factor-row" key={factor.id}>
              <strong>{factor.label}</strong>
              <div className="factor-bars">
                <div><span>Today</span><i><b style={{ width: `${(factor.current / factor.maximum) * 100}%` }} /></i><em>{factor.current}/{factor.maximum}</em></div>
                <div><span>Potential</span><i><b style={{ width: `${(factor.potential / factor.maximum) * 100}%` }} /></i><em>{factor.potential}/{factor.maximum}</em></div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="implementation-cta">
        <div><span className="cta-icon">⌘</span><span><strong>Turn this simulation into a plan.</strong><small>Generate a Codex prompt or agency handoff — even without a repository.</small></span></div>
        <button className="primary-button" type="button" onClick={onOpenImplementation}>Build implementation pack <span>→</span></button>
      </div>
    </section>
  )
}
