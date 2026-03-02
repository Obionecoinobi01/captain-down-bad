import { useState } from 'react'
import { IntroScreen } from './IntroScreen'
import { GameScreen } from './GameScreen'
import './App.css'

function App() {
  const [runId, setRunId] = useState<bigint | undefined>()

  if (runId === undefined) {
    return <IntroScreen onStart={setRunId} />
  }

  return <GameScreen runId={runId} onBack={() => setRunId(undefined)} />
}

export default App
