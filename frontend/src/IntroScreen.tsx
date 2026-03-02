import { useEffect, useState } from 'react'
import { useAccount, useConnect, useDisconnect } from 'wagmi'
import { TitleScreen } from './TitleScreen'
import { useUsdcBalance } from './useGameState'
import { useStartRun } from './useStartRun'

interface Props {
  onStart: (runId: bigint) => void
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
  const { connect, connectors } = useConnect()
  const { disconnect } = useDisconnect()
  const { formatted: usdcBalance } = useUsdcBalance(address)
  const { startRun, status, runId, error, reset } = useStartRun(address)
  const [bet, setBet] = useState('1.00')
  const [attracted, setAttracted] = useState(true)

  // Once run is confirmed, pass runId up to App
  useEffect(() => {
    if (status === 'done' && runId !== undefined) {
      const t = setTimeout(() => onStart(runId), 900)
      return () => clearTimeout(t)
    }
  }, [status, runId, onStart])

  const busy = status !== 'idle' && status !== 'done' && status !== 'error'

  function handleStart() {
    if (status === 'error') { reset(); return }
    if (!busy && status !== 'done') startRun(bet)
  }

  const actionLabel = status === 'done' && runId !== undefined
    ? `RUN #${runId.toString()} STARTED!`
    : TX_LABEL[status] ?? '— PRESS START —'

  // Prefer injected (MetaMask / browser wallet), fallback to first available
  const connector = connectors.find(c => c.id === 'injected') ?? connectors[0]

  return (
    <div
      className="intro-screen"
      onClick={attracted ? () => setAttracted(false) : undefined}
    >
      {/* ── Title art ── */}
      <div className="intro-title-area">
        <div className="intro-label-top">AND THE HUNT FOR THE</div>

        <h1 className="intro-main-title">
          <span className="intro-captain">CAPTAIN</span>
          <div className="intro-downbad-wrap">
            <span className="intro-downbad">DOWN BAD</span>
          </div>
        </h1>

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
              <button
                className="intro-connect-btn"
                onClick={e => { e.stopPropagation(); connect({ connector }) }}
              >
                CONNECT WALLET
              </button>
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
                onClick={e => { e.stopPropagation(); handleStart() }}
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
