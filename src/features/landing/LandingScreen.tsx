import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { readWrapperHealth } from '../wrapper/wrapperApi'

interface LandingScreenProps {
  onAnalyze: (url: string) => Promise<string | null>
  onDemo: () => void
}

export function LandingScreen({ onAnalyze, onDemo }: LandingScreenProps) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  // `null` means the health contract has not answered yet or could not be read.
  // The notice appears only on a definite negative, never on an unknown state.
  const [liveAnalysisReady, setLiveAnalysisReady] = useState<boolean | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void readWrapperHealth(controller.signal)
      .then((health) => {
        if (!controller.signal.aborted && health) setLiveAnalysisReady(health.ready)
      })
      // The health read already fails soft, but the landing screen must not
      // depend on that: an unhandled rejection here would surface as a console
      // error on a page whose entire purpose is to look trustworthy.
      .catch(() => undefined)
    return () => controller.abort()
  }, [])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!url.trim()) {
      setError('Enter a public website URL or try the HeatFlow demo.')
      return
    }
    setAnalyzing(true)
    setError('')
    try {
      setError(await onAnalyze(url) ?? '')
    } finally {
      setAnalyzing(false)
    }
  }

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="#top" aria-label="WebMCP Simulator home">
          <span className="brand-mark" aria-hidden="true"><span /><span /></span>
          <span>WebMCP Simulator</span>
        </a>
        <div className="challenge-pill"><span className="live-dot" aria-hidden="true" />OpenAI WebMCP Challenge</div>
      </header>

      <main id="top">
        <section className="hero-section">
          <div className="hero-copy">
            <p className="eyebrow"><span>Explore the agentic web</span><span className="eyebrow-line" aria-hidden="true" /></p>
            <h1>See what your website could become with <span className="gradient-text">WebMCP.</span></h1>
            <p className="hero-description">
              Paste a URL and experience how AI agents could interact with your
              website through structured tools — before implementing anything.
            </p>

            <form className="url-composer" onSubmit={(event) => void handleSubmit(event)} aria-busy={analyzing}>
              <label className="sr-only" htmlFor="website-url">Public website URL</label>
              <span className="url-icon" aria-hidden="true">⌁</span>
              <input
                id="website-url"
                type="text"
                inputMode="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://yourwebsite.com"
                autoComplete="url"
                aria-describedby={error ? 'url-error' : undefined}
                disabled={analyzing}
              />
              <button type="submit" disabled={analyzing}>{analyzing ? 'Opening isolated browser…' : 'Analyze website'} <span aria-hidden="true">→</span></button>
            </form>
            {error && <p className="form-error" id="url-error">{error}</p>}

            {/* The submitted error is the more specific of the two and replaces
                the standing notice, so a visitor never reads the same boundary
                explained twice in adjacent paragraphs. */}
            {!error && liveAnalysisReady === false && (
              <p className="deployment-notice">
                <span aria-hidden="true">◎</span>
                Analyzing your own website runs a real browser in an isolated sandbox,
                which is not enabled on this public deployment. The HeatFlow demo below
                registers the same real WebMCP tools.
              </p>
            )}

            <button className="demo-link" type="button" onClick={onDemo}>
              <span className="play-mark" aria-hidden="true">▶</span>
              Try the HeatFlow demo
              <span aria-hidden="true">→</span>
            </button>

            <p className="demo-explainer">
              HeatFlow is a <strong>fictional</strong> heating company built into the
              simulator. Its website is a stand-in, so you can experience WebMCP without
              needing a site that already implements it. The tools registered on it are
              real and run through the browser&rsquo;s <code>document.modelContext</code> API.
            </p>
          </div>

          <div className="hero-visual" role="img" aria-label="WebMCP opportunity preview">
            <div className="visual-glow" />
            <div className="browser-card">
              <div className="browser-bar">
                <div className="browser-dots" aria-hidden="true"><span /><span /><span /></div>
                <div className="browser-url"><span aria-hidden="true">◇</span> heatflow.example</div>
                <span className="browser-menu" aria-hidden="true">•••</span>
              </div>
              <div className="website-preview">
                <div className="preview-header">
                  <div className="heatflow-logo"><span aria-hidden="true">◒</span> HeatFlow</div>
                  <div className="preview-nav"><span>Services</span><span>Solutions</span><span>Contact</span></div>
                </div>
                <div className="preview-hero"><p>Smart heating for every home.</p><div className="preview-lines"><span /><span /></div></div>
                <div className="preview-services"><span /><span /><span /></div>
                <div className="opportunity-tag opportunity-search"><span>✦</span><div><strong>WebMCP opportunity</strong><small>Search services</small></div></div>
                <div className="opportunity-tag opportunity-area"><span>✦</span><div><strong>WebMCP opportunity</strong><small>Check service area</small></div></div>
              </div>
            </div>
            <div className="tool-card">
              <div className="tool-card-head"><span className="tool-glyph">⌘</span><span>Tool discovered</span><span className="impact-badge">HIGH IMPACT</span></div>
              <code>check_service_area</code>
              <p>Check installation availability using structured inputs.</p>
              <div className="tool-schema"><span>postcode</span><b>"2230"</b></div>
            </div>
          </div>
        </section>

        <section className="steps-section" aria-label="How it works">
          <div className="section-kicker">HOW IT WORKS</div>
          <div className="steps-grid">
            <article><span>01</span><div className="step-icon">⌕</div><h2>Analyze</h2><p>We inspect visible functionality and interaction patterns.</p></article>
            <article><span>02</span><div className="step-icon">✦</div><h2>Discover opportunities</h2><p>See which workflows could become explicit agent tools.</p></article>
            <article><span>03</span><div className="step-icon">⌁</div><h2>Experience WebMCP</h2><p>Watch a real agent call tools and change the simulator live.</p></article>
          </div>
        </section>
        <section className="agent-test-section" aria-label="Test it with an agent">
          <div className="section-kicker">TEST IT WITH AN AGENT</div>
          <p className="agent-test-intro">
            The simulation registers real WebMCP tools. A compatible agent can discover
            and invoke them — here is how to see that for yourself.
          </p>
          <div className="agent-test-grid">
            <article>
              <h2>Google Chrome</h2>
              <ol>
                <li>Open <code>chrome://flags/#enable-webmcp-testing</code> and enable it.</li>
                <li>Relaunch Chrome.</li>
                <li>Open the HeatFlow demo above and launch the simulation.</li>
                <li>The tools appear in <code>document.modelContext</code>.</li>
              </ol>
              <p className="agent-test-note">
                <code>executeTool</code> takes the registered tool object, not its name,
                and its arguments as a JSON string.
              </p>
            </article>
            <article>
              <h2>ChatGPT in-app browser</h2>
              <ol>
                <li>Open this page in ChatGPT with site tools enabled.</li>
                <li>Launch the HeatFlow simulation.</li>
                <li>Ask the agent to check postcode <code>2230</code> for a heat pump.</li>
                <li>Every accepted call changes the page visibly.</li>
              </ol>
              <p className="agent-test-note">
                Unsupported browsers keep the full human interface and report an accurate
                compatibility message instead of a fake connection.
              </p>
            </article>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <p><span aria-hidden="true">◎</span> Safe by design</p>
        <p>This is a simulation. Your original website remains unchanged.</p>
      </footer>
    </div>
  )
}
