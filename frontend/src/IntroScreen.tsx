import { useEffect, useRef, useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { TitleScreen } from './TitleScreen'
import { useUsdcBalance } from './useGameState'
import { useStartRun } from './useStartRun'
import { startIntroTrack, stopIntroTrack, playUIClick } from './sound'

interface Props {
  onStart: (runId: bigint, levelId: number) => void
}

const TX_LABEL: Record<string, string> = {
  idle:            '— PRESS START —',
  approving:       'APPROVING USDC...',
  approve_pending: 'CONFIRMING APPROVAL...',
  starting:        'STARTING RUN...',
  start_pending:   'CONFIRMING...',
  done:            'RUN STARTED!',
  error:           '✗ TRY AGAIN',
}

export function IntroScreen({ onStart }: Props) {
  const { address, isConnected } = useAccount()
  const { connect, connectors, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const { formatted: usdcBalance } = useUsdcBalance(address)
  const { startRun, status, runId, error, reset } = useStartRun(address)
  const [bet, setBet]               = useState('1.00')
  const [levelId, setLevelId]       = useState(0)
  const [showVideo, setShowVideo]   = useState(true)   // intro cinematic phase
  const [attracted, setAttracted]   = useState(true)   // attract / press-start phase
  const videoRef = useRef<HTMLVideoElement>(null)

  function skipVideo() {
    setShowVideo(false)
  }

  // Once run is confirmed, fade out intro track then hand off
  useEffect(() => {
    if (status === 'done' && runId !== undefined) {
      stopIntroTrack()
      const t = setTimeout(() => onStart(runId, levelId), 900)
      return () => clearTimeout(t)
    }
  }, [status, runId, onStart, levelId])

  const busy = status !== 'idle' && status !== 'done' && status !== 'error'

  function handleStart() {
    if (status === 'error') { reset(); return }
    if (!busy && status !== 'done') startRun(bet, BigInt(levelId))
  }

  const actionLabel = status === 'done' && runId !== undefined
    ? `RUN #${runId.toString()} STARTED!`
    : TX_LABEL[status] ?? '— PRESS START —'


  return (
    <div
      className="intro-screen"
      onClick={attracted && !showVideo ? () => { setAttracted(false); startIntroTrack() } : undefined}
    >
      {/* ── Cinematic intro video (plays once, muted, full-screen) ── */}
      {showVideo && (
        <div className="intro-video-wrap" onClick={skipVideo}>
          <video
            ref={videoRef}
            className="intro-video"
            src="/video/intro.mp4"
            autoPlay
            muted
            playsInline
            onEnded={skipVideo}
          />
          <div className="intro-skip-hint">TAP TO SKIP ▶</div>
        </div>
      )}

      {/* ── Title art ── */}
      <div className="intro-title-area">
        <h1 className="intro-main-title">
          <span className="intro-captain">CAPTAIN</span>
          <div className="intro-downbad-wrap">
            <span className="intro-downbad">DOWN BAD</span>
          </div>
        </h1>

        <div className="intro-label-top">AND THE HUNT FOR THE</div>

        <div className="intro-magical-d">
          MAGICAL&nbsp;<span className="intro-d-gem">D</span>
        </div>
      </div>

      {/* ── Walking characters ── */}
      <div className="intro-characters-strip">
        <TitleScreen />
      </div>

      {/* ── Attract mode: blink PRESS START ── */}
      {attracted && (
        <div className="intro-press-start">— PRESS START —</div>
      )}

      {/* ── Post-attract: wallet + bet + action ── */}
      {!attracted && (
        <div className="intro-actions">
          {!isConnected ? (
            <>
              <div className="intro-connect-hint">CONNECT WALLET TO PLAY</div>
              {connectors.map(c => (
                <button
                  key={c.id}
                  className="intro-connect-btn"
                  onClick={e => { e.stopPropagation(); playUIClick(); connect({ connector: c }) }}
                >
                  {c.name.toUpperCase()}
                </button>
              ))}
              {connectError && (
                <div className="intro-error">{connectError.message.slice(0, 100)}</div>
              )}
            </>
          ) : (
            <>
              <div className="intro-balance">
                BALANCE: <span>{usdcBalance} USDC</span>
              </div>

              <div className="intro-bet-row">
                <span className="intro-insert-label">INSERT TOKEN:</span>
                <input
                  className="intro-bet-input"
                  type="number"
                  min="0.01"
                  step="0.01"
                  value={bet}
                  disabled={busy || status === 'done'}
                  onChange={e => { setBet(e.target.value); if (status === 'error') reset() }}
                  onClick={e => e.stopPropagation()}
                />
              </div>

              <div className="intro-level-row">
                <span className="intro-insert-label">STAGE:</span>
                {[0, 1].map(lvl => (
                  <button
                    key={lvl}
                    className={['intro-level-btn', levelId === lvl ? 'active' : ''].join(' ').trim()}
                    disabled={busy || status === 'done'}
                    onClick={e => { e.stopPropagation(); playUIClick(); setLevelId(lvl) }}
                  >
                    {lvl === 0 ? '1 — FLAT CITY' : '2 — SKY TOWERS'}
                  </button>
                ))}
              </div>

              {error && (
                <div className="intro-error">{error.slice(0, 120)}</div>
              )}

              <button
                className={[
                  'intro-action-btn',
                  status === 'done'  ? 'done'  : '',
                  busy               ? 'busy'  : '',
                  status === 'error' ? 'error' : '',
                ].join(' ').trim()}
                disabled={busy}
                onClick={e => { e.stopPropagation(); playUIClick(); handleStart() }}
              >
                {actionLabel}
              </button>

              <button
                className="intro-disconnect-btn"
                onClick={e => { e.stopPropagation(); disconnect() }}
              >
                disconnect
              </button>
            </>
          )}
        </div>
      )}

      <div className="intro-copyright">
        &copy; 2025 &nbsp; ON&#8209;CHAIN GAMES &nbsp; BASE NETWORK
      </div>
    </div>
  )
}
