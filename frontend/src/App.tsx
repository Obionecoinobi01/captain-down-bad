import { useState } from 'react'
import { IntroScreen } from './IntroScreen'
import { GameScreen } from './GameScreen'
import './App.css'

function App() {
  const [runId,   setRunId]   = useState<bigint | undefined>()
  const [levelId, setLevelId] = useState<number>(0)

  if (runId === undefined) {
    return (
      <IntroScreen
        onStart={(id, lvl) => { setRunId(id); setLevelId(lvl) }}
      />
    )
  }

  return (
    <GameScreen
      runId={runId}
      levelId={levelId}
      onBack={() => setRunId(undefined)}
    />
  )
}

export default App
