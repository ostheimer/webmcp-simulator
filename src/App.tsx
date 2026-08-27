import { useState } from 'react'
import './App.css'
import { heatFlowAnalysis } from './demo/heatflow/data'
import { createLimitedAnalysis, type AnalysisAttempt } from './features/analysis/analyzer'
import { LandingScreen } from './features/landing/LandingScreen'
import { AnalysisWorkspace } from './features/opportunities/AnalysisWorkspace'
import { SimulationWorkspace } from './features/simulation/SimulationWorkspace'

type AppView = 'landing' | 'analysis' | 'simulation'

const demoAttempt: AnalysisAttempt = {
  analysis: heatFlowAnalysis,
  limited: false,
}

function App() {
  const [view, setView] = useState<AppView>('landing')
  const [attempt, setAttempt] = useState<AnalysisAttempt>(demoAttempt)

  function openDemoAnalysis() {
    setAttempt(demoAttempt)
    setView('analysis')
    window.scrollTo({ top: 0 })
  }

  function openLanding() {
    setView('landing')
    window.scrollTo({ top: 0 })
  }

  function analyzeUrl(url: string): string | null {
    try {
      setAttempt(createLimitedAnalysis(url))
      setView('analysis')
      window.scrollTo({ top: 0 })
      return null
    } catch (error) {
      return error instanceof Error && error.message !== 'Invalid URL'
        ? error.message
        : 'Enter a valid public website URL.'
    }
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
