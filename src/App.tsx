import { useState } from 'react'
import './App.css'
import { heatFlowAnalysis } from './demo/heatflow/data'
import { normalizeWebsiteUrl, type AnalysisAttempt } from './features/analysis/analyzer'
import { LandingScreen } from './features/landing/LandingScreen'
import { AnalysisWorkspace } from './features/opportunities/AnalysisWorkspace'
import { SimulationWorkspace } from './features/simulation/SimulationWorkspace'
import { WrapperProofWorkspace } from './features/wrapper/WrapperProofWorkspace'
import { analyzeWebsiteInWrapper } from './features/wrapper/wrapperApi'
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

  function openDemoAnalysis() {
    setAttempt(demoAttempt)
    setView('analysis')
    window.scrollTo({ top: 0 })
  }

  function openLanding() {
    setView('landing')
    window.scrollTo({ top: 0 })
  }

  async function analyzeUrl(url: string): Promise<string | null> {
    try {
      const normalizedUrl = normalizeWebsiteUrl(url)
      const analysis = await analyzeWebsiteInWrapper(normalizedUrl)
      setWrapperAnalysis(analysis)
      setView('wrapper')
      window.scrollTo({ top: 0 })
      return null
    } catch (error) {
      return error instanceof Error && error.message !== 'Invalid URL'
        ? error.message
        : 'Enter a valid public website URL.'
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
          setView('simulation')
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
