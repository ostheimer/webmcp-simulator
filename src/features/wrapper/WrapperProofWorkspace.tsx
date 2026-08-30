import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createWrapperTools } from '../../webmcp/createWrapperTools'
import { registerTools } from '../../webmcp/registerTools'
import {
  closeWrapperSession,
  executeWrapperAction,
  WrapperApiError,
} from './wrapperApi'
import {
  retireWrapperSessionResources,
  type WrapperSessionCredentials,
} from './wrapperSessionLifecycle'
import type {
  WrapperActionResult,
  WrapperActivity,
  WrapperAnalysis,
  WrapperCapability,
} from './types'

interface WrapperProofWorkspaceProps {
  analysis: WrapperAnalysis
  onBack: () => void
}

type RegistrationState = 'checking' | 'connected' | 'unavailable' | 'error'

export function WrapperSessionRetiredNotice({
  message,
  onBack,
}: {
  message: string
  onBack: () => void
}) {
  return (
    <div className="workspace-shell wrapper-proof-shell">
      <header className="workspace-header wrapper-proof-header">
        <button className="workspace-brand" type="button" onClick={onBack}>
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>WebMCP Simulator</span>
        </button>
      </header>
      <main className="wrapper-proof-layout">
        <section className="wrapper-browser-panel support-message error" role="alert">
          <strong>Browser-Sitzung beendet</strong>
          <p>{message}</p>
          <p>Die bisherige Analyse und ihre WebMCP-Tools wurden entfernt. Analysiere die Website erneut, um mit einer frischen isolierten Sitzung fortzufahren.</p>
          <button className="primary-button" type="button" onClick={onBack}>Website erneut analysieren</button>
        </section>
      </main>
    </div>
  )
}

function registrationLabel(state: RegistrationState): string {
  if (state === 'connected') return 'WEBMCP CONNECTED'
  if (state === 'unavailable') return 'TOOLS PROPOSED'
  if (state === 'error') return 'REGISTRATION ERROR'
  return 'REGISTERING TOOLS'
}

function formatDuration(runtimeMs: number): string {
  return `${Math.max(0, runtimeMs / 1_000).toFixed(1)} s`
}

function formatCost(lowerBound: number, upperBound: number): string {
  return `$${lowerBound.toFixed(4)}–$${upperBound.toFixed(4)}`
}

export function WrapperProofWorkspace({ analysis, onBack }: WrapperProofWorkspaceProps) {
  const [currentAnalysis, setCurrentAnalysis] = useState<WrapperAnalysis | null>(analysis)
  const [activities, setActivities] = useState<WrapperActivity[]>([])
  const [registration, setRegistration] = useState<RegistrationState>('checking')
  const [registrationError, setRegistrationError] = useState('')
  const [actionError, setActionError] = useState('')
  const [busyTool, setBusyTool] = useState('')
  const registrationControllerRef = useRef<AbortController | null>(null)
  const credentialsRef = useRef<WrapperSessionCredentials | null>({
    sessionId: analysis.sessionId,
    sessionToken: analysis.sessionToken,
  })

  const runCapability = useCallback(async (
    capability: WrapperCapability,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<WrapperActionResult> => {
    if (!currentAnalysis) {
      throw new WrapperApiError('The isolated browser session is no longer active.', {
        code: 'session_expired',
        sessionInvalidated: true,
      })
    }
    setBusyTool(capability.name)
    setActionError('')
    try {
      const result = await executeWrapperAction(
        currentAnalysis.sessionId,
        currentAnalysis.sessionToken,
        capability.id,
        capability.name,
        input,
        signal,
      )
      if (signal.aborted) throw new DOMException('The tool call was cancelled.', 'AbortError')
      setRegistration('checking')
      setCurrentAnalysis(result.analysis)
      setActivities((current) => [result.activity, ...current])
      return result
    } catch (error) {
      const aborted = signal.aborted
        || (error instanceof DOMException && error.name === 'AbortError')
      const message = aborted
        ? 'Der Wrapper-Tool-Aufruf wurde abgebrochen. Der Zustand der isolierten Sitzung ist nicht mehr eindeutig.'
        : error instanceof Error ? error.message : 'The isolated tool call failed.'
      setActionError(message)
      const shouldRetire = aborted || (error instanceof WrapperApiError
        ? error.sessionInvalidated !== false
        : true)
      if (shouldRetire) {
        retireWrapperSessionResources(
          registrationControllerRef.current,
          credentialsRef,
          closeWrapperSession,
        )
        registrationControllerRef.current = null
        setCurrentAnalysis(null)
        setRegistration('error')
      }
      throw error
    } finally {
      setBusyTool('')
    }
  }, [currentAnalysis])

  useLayoutEffect(() => {
    if (!currentAnalysis) {
      registrationControllerRef.current?.abort()
      registrationControllerRef.current = null
      return
    }
    const controller = new AbortController()
    registrationControllerRef.current = controller
    let active = true
    const tools = createWrapperTools(currentAnalysis, { execute: runCapability })
    registerTools(tools, { controller })
      .then((result) => {
        if (active) setRegistration(result.supported ? 'connected' : 'unavailable')
      })
      .catch((error: unknown) => {
        if (!active || controller.signal.aborted) return
        setRegistrationError(error instanceof Error ? error.message : 'Tool registration failed.')
        setRegistration('error')
      })
    return () => {
      active = false
      controller.abort()
      if (registrationControllerRef.current === controller) {
        registrationControllerRef.current = null
      }
    }
  }, [currentAnalysis, runCapability])

  useEffect(() => () => {
    const credentials = credentialsRef.current
    credentialsRef.current = null
    if (credentials) closeWrapperSession(credentials.sessionId, credentials.sessionToken)
  }, [])

  function invokeSample(capability: WrapperCapability) {
    const controller = new AbortController()
    void runCapability(capability, capability.sampleInput, controller.signal).catch(() => undefined)
  }

  if (!currentAnalysis) {
    return <WrapperSessionRetiredNotice message={actionError} onBack={onBack} />
  }

  return (
    <div className="workspace-shell wrapper-proof-shell">
      <header className="workspace-header wrapper-proof-header">
        <button className="workspace-brand" type="button" onClick={onBack}>
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>WebMCP Simulator</span>
        </button>
        <div className="workspace-context"><span className="context-dot" />Isolated browser proof</div>
        <button className="ghost-button" type="button" onClick={onBack}>New website</button>
      </header>

      <div className="wrapper-safety-banner">
        <div><span className="simulation-pulse" /><strong>Live wrapper proof</strong><span>Original website unchanged</span></div>
        <p>Fresh Chromium session · no profile cookies · preparation blocks network · navigation is explicit</p>
      </div>

      <main className="wrapper-proof-layout">
        <section className="wrapper-browser-panel">
          <div className="panel-heading-row">
            <div><span className="workspace-kicker">ISOLATED TARGET</span><h1>{currentAnalysis.title}</h1></div>
            <span className="simulation-chip">Real screenshot</span>
          </div>
          <p className="wrapper-target-url" data-testid="current-wrapper-url">{currentAnalysis.finalUrl}</p>
          <div className="wrapper-runtime-strip" role="group" aria-label="Sitzungs- und Kostengrenzen">
            <span><small>UMGEBUNG</small><strong>{currentAnalysis.runtime.provider === 'vercel-sandbox' ? 'Vercel Sandbox' : 'Lokales Chromium'}</strong></span>
            <span><small>ANALYSIERTE SEITEN</small><strong>{currentAnalysis.analyzedPages} / {currentAnalysis.maxPages}</strong></span>
            <span><small>LAUFZEIT</small><strong>{formatDuration(currentAnalysis.runtime.runtimeMs)}</strong></span>
            <span><small>NETZWERK</small><strong>{currentAnalysis.runtime.allowedNetworkRequests} erlaubt · {currentAnalysis.runtime.blockedNetworkRequests} blockiert</strong></span>
            <span><small>NÄHERUNGSWERT</small><strong>{formatCost(
              currentAnalysis.runtime.estimatedCost.lowerBound,
              currentAnalysis.runtime.estimatedCost.upperBound,
            )}</strong></span>
          </div>
          <div className="wrapper-screenshot-frame">
            <div className="browser-bar">
              <div className="browser-dots" aria-hidden="true"><span /><span /><span /></div>
              <div className="browser-url">◇ {currentAnalysis.finalUrl}</div>
              <span className="browser-menu" aria-hidden="true">ISOLATED</span>
            </div>
            <img src={currentAnalysis.screenshotDataUrl} alt={`Current isolated browser view of ${currentAnalysis.title}`} />
          </div>

          <div className="wrapper-evidence-grid">
            <section>
              <span className="workspace-kicker">DOM EVIDENCE</span>
              <h2>{currentAnalysis.domEvidence.length} visible interactions observed</h2>
              <div className="wrapper-evidence-list">
                {currentAnalysis.domEvidence.slice(0, 8).map((item) => (
                  <div key={item.id}>
                    <span className={item.sensitive ? 'evidence-blocked' : 'evidence-check'}>{item.sensitive ? '×' : '✓'}</span>
                    <span><strong>{item.role} · {item.type}</strong><small>Untrusted label: “{item.label}”</small></span>
                  </div>
                ))}
              </div>
            </section>
            <section>
              <span className="workspace-kicker">ACCESSIBILITY EVIDENCE</span>
              <h2>{currentAnalysis.axEvidence.length} named AX nodes retained</h2>
              <div className="wrapper-ax-list">
                {currentAnalysis.axEvidence.slice(0, 8).map((item, index) => (
                  <div key={`${item.role}-${item.name}-${index}`}><code>{item.role}</code><span>{item.name}</span></div>
                ))}
              </div>
            </section>
          </div>
        </section>

        <aside className="wrapper-agent-panel" aria-label="Wrapper WebMCP tools and agent activity">
          <div className="wrapper-agent-heading">
            <div><span className="agent-orb">⌘</span><span><strong>Wrapper agent</strong><small>{currentAnalysis.capabilities.length} safe tools inferred</small></span></div>
            <span className={`webmcp-state state-${registration}`}>{registrationLabel(registration)}</span>
          </div>
          {registration === 'unavailable' && <div className="support-message"><strong>Browser WebMCP unavailable</strong><p>The tools remain testable through the same local handlers. A compatible browser can discover them through document.modelContext.</p></div>}
          {registrationError && <div className="support-message error"><strong>Registration failed</strong><p>{registrationError}</p></div>}

          <section className="wrapper-tools">
            <div className="agent-section-label"><span>DYNAMIC TOOLS</span><em>{currentAnalysis.capabilities.length}</em></div>
            {currentAnalysis.capabilities.length === 0 ? (
              <div className="empty-activity"><span>◇</span><strong>No safe tool detected</strong><p>This page is visible, but the proof will not invent an interaction.</p></div>
            ) : currentAnalysis.capabilities.map((capability) => (
              <article className="wrapper-tool-card" key={capability.id}>
                <div><span className="tool-mini-icon">✦</span><span><code>{capability.name}</code><small>{capability.description}</small></span></div>
                <pre tabIndex={0}>{JSON.stringify(capability.inputSchema, null, 2)}</pre>
                {capability.kind === 'navigation' && (
                  <div className="wrapper-option-map">
                    {capability.evidenceIds.map((evidenceId, index) => {
                      const evidence = currentAnalysis.domEvidence.find(({ id }) => id === evidenceId)
                      return <small key={evidenceId}><b>{index}</b> Untrusted page label: “{evidence?.label || 'Unnamed link'}”</small>
                    })}
                  </div>
                )}
                <button
                  type="button"
                  disabled={Boolean(busyTool)}
                  onClick={() => invokeSample(capability)}
                >
                  {busyTool === capability.name ? 'Agent is acting…' : 'Invoke as agent'} <span>→</span>
                </button>
              </article>
            ))}
          </section>

          <section className="wrapper-activity" aria-live="polite">
            <div className="agent-section-label"><span>AGENT ACTIVITY</span><em>{activities.length}</em></div>
            {activities.length === 0 ? (
              <div className="empty-activity"><span>◎</span><strong>Waiting for a tool call</strong><p>Every successful call must change the isolated page and refresh the screenshot.</p></div>
            ) : activities.map((activity) => (
              <div className="activity-item" key={activity.id}>
                <span>✓</span><div><strong>{activity.summary}</strong><code>{activity.toolName}</code></div><time>{new Date(activity.createdAt).toLocaleTimeString()}</time>
              </div>
            ))}
          </section>

          {actionError && <div className="support-message error" role="alert"><strong>Tool call failed</strong><p>{actionError}</p></div>}
          <div className="wrapper-proof-boundary">
            <strong>Sicherheits- und Kostengrenze</strong>
            <p>{currentAnalysis.blockedRequests} Requests blockiert. Seiteninhalt bleibt nicht vertrauenswürdig. Vorbereitung ist netzwerkstill; Navigation erlaubt nur explizite Same-Origin-GET/HEAD-Zugriffe. Die Kostenspanne ist ein grober Listenpreis-Näherungswert, keine Abrechnungsgarantie.</p>
          </div>
        </aside>
      </main>
    </div>
  )
}
