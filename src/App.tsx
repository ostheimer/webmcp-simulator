import { useEffect, useRef, useState } from 'react'
import './App.css'
import { heatFlowAnalysis } from './demo/heatflow/data'
import { normalizeWebsiteUrl, type AnalysisAttempt } from './features/analysis/analyzer'
import { LandingScreen } from './features/landing/LandingScreen'
import { AnalysisWorkspace } from './features/opportunities/AnalysisWorkspace'
import { SimulationWorkspace } from './features/simulation/SimulationWorkspace'
import { WrapperProofWorkspace } from './features/wrapper/WrapperProofWorkspace'
import { analyzeWebsiteInWrapper, closeWrapperSession, WrapperApiError } from './features/wrapper/wrapperApi'
import { wrapperErrorCopy } from './features/wrapper/wrapperErrorCopy'
import type { WrapperAnalysis } from './features/wrapper/types'

type AppView = 'landing' | 'analysis' | 'simulation' | 'wrapper'

const demoAttempt: AnalysisAttempt = {
  analysis: heatFlowAnalysis,
  limited: false,
}

function App() {
  const [view, setView] = useState<AppView>('landing')
  const [attempt, setAttempt] = useState<AnalysisAttempt>(demoAttempt)
  const [wrapperAnalysis, setWrapperAnalysis] = useState<WrapperAnalysis | null>(null)
  const viewRef = useRef<AppView>('landing')
  const requestGenerationRef = useRef(0)
  const activeAnalysisRef = useRef<{ generation: number, controller: AbortController } | null>(null)

  function updateView(nextView: AppView) {
    viewRef.current = nextView
    setView(nextView)
  }

  function cancelPendingAnalysis() {
    requestGenerationRef.current += 1
    activeAnalysisRef.current?.controller.abort()
    activeAnalysisRef.current = null
  }

  useEffect(() => () => cancelPendingAnalysis(), [])

  function openDemoAnalysis() {
    cancelPendingAnalysis()
    setAttempt(demoAttempt)
    updateView('analysis')
    window.scrollTo({ top: 0 })
  }

  function openLanding() {
    cancelPendingAnalysis()
    updateView('landing')
    window.scrollTo({ top: 0 })
  }

  async function analyzeUrl(url: string): Promise<string | null> {
    cancelPendingAnalysis()
    const generation = requestGenerationRef.current
    const controller = new AbortController()
    activeAnalysisRef.current = { generation, controller }
    try {
      const normalizedUrl = normalizeWebsiteUrl(url)
      const analysis = await analyzeWebsiteInWrapper(normalizedUrl, controller.signal)
      const isCurrentRequest = activeAnalysisRef.current?.generation === generation
        && !controller.signal.aborted
        && viewRef.current === 'landing'
      if (!isCurrentRequest) {
        closeWrapperSession(analysis.sessionId, analysis.sessionToken)
        return null
      }
      activeAnalysisRef.current = null
      setWrapperAnalysis(analysis)
      updateView('wrapper')
      window.scrollTo({ top: 0 })
      return null
    } catch (error) {
      if (
        controller.signal.aborted
        || (error instanceof DOMException && error.name === 'AbortError')
        || activeAnalysisRef.current?.generation !== generation
      ) return null
      if (error instanceof WrapperApiError) return wrapperErrorCopy(error.code, error.message)
      return error instanceof Error && error.message !== 'Invalid URL'
        ? error.message
        : 'Enter a valid public website URL.'
    } finally {
      if (activeAnalysisRef.current?.generation === generation) activeAnalysisRef.current = null
    }
  }

  if (view === 'wrapper' && wrapperAnalysis) {
    return <WrapperProofWorkspace analysis={wrapperAnalysis} onBack={openLanding} />
  }

  if (view === 'analysis') {
    return (
      <AnalysisWorkspace
        attempt={attempt}
        onBack={openLanding}
        onDemo={openDemoAnalysis}
        onLaunch={() => {
          updateView('simulation')
          window.scrollTo({ top: 0 })
        }}
      />
    )
  }

  if (view === 'simulation') {
    return <SimulationWorkspace onBack={openDemoAnalysis} />
  }

  return <LandingScreen onAnalyze={analyzeUrl} onDemo={openDemoAnalysis} />
}

export default App
