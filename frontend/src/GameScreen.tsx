import { useCallback, useEffect, useRef, useState } from 'react'
import { useRun, useGemEventFetcher } from './useGameState'
import { useSessionKey } from './useSessionKey'
import { useSubmitMove, MOVE_LABELS } from './useSubmitMove'
import type { Move } from './useSubmitMove'

interface Props {
  runId: bigint
  onBack: () => void
}

// ── Canvas config ──────────────────────────────────────────────────────────────
const TILE = 8   // canvas pixels per tile cell
const COLS = 32
const ROWS = 16

// ── Sprite palette ─────────────────────────────────────────────────────────────
const K  = '#111111'
const _s = null
const CB = '#4499ff'
const CS = '#ffcc99'
const CG = '#ffdd00'
const CL = '#1155cc'

type Px    = string | null
type Frame = Px[][]

const CAPTAIN_FRAMES: Frame[] = [
  [
    [_s,_s, K, K, K, K,_s,_s],
    [_s, K,CS,CS,CS, K,_s,_s],
    [ K,CB,CS,CS,CS,CB, K,_s],
    [ K,CB, K,CG, K,CB, K,_s],
    [ K,CB,CB,CB,CB,CB, K,_s],
    [_s, K,CL,CL,CL, K,_s,_s],
    [_s, K,CL,_s,CL, K,_s,_s],
    [_s, K, K,_s, K, K,_s,_s],
  ],
  [
    [_s,_s, K, K, K, K,_s,_s],
    [_s, K,CS,CS,CS, K,_s,_s],
    [ K,CB,CS,CS,CS,CB, K,_s],
    [ K,CB, K,CG, K,CB, K,_s],
    [ K,CB,CB,CB,CB,CB, K,_s],
    [_s, K,CL,CL,CL, K,_s,_s],
    [_s,_s, K,CL,CL, K,_s,_s],
    [_s,_s, K, K, K, K,_s,_s],
  ],
]

// ── Level — decoded from contract LEVEL_MAP_BYTES ─────────────────────────────
//  0 = air   1 = wall/platform   2 = gem   3 = spike   4 = enemy
const LEVEL: number[][] = (() => {
  const g = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0))
  for (let x = 8;  x <= 14; x++) g[9][x]  = 1  // left platform
  for (let x = 16; x <= 22; x++) g[11][x] = 1  // right platform
  for (let x = 0;  x < COLS; x++) g[15][x] = 1  // floor
  g[8][10] = 2; g[8][12] = 2                    // gems
  g[10][18] = 2; g[10][20] = 2
  g[8][8] = 4;  g[14][16] = 4                   // enemies
  g[14][5] = 3; g[14][25] = 3                   // spikes
  return g
})()

// ── Drawing helpers ────────────────────────────────────────────────────────────
function drawTile(ctx: CanvasRenderingContext2D, tile: number, px: number, py: number, t: number) {
  switch (tile) {
    case 0: return
    case 1:
      ctx.fillStyle = '#1a2a4e'
      ctx.fillRect(px, py, TILE, TILE)
      ctx.fillStyle = '#2a3d72'
      ctx.fillRect(px, py, TILE, 1)
      ctx.fillRect(px, py, 1, TILE)
      ctx.fillStyle = '#0d1a30'
      ctx.fillRect(px, py + TILE - 1, TILE, 1)
      return
    case 2: {
      const b = (Math.sin(t * 0.08 + px * 0.4) + 1) * 0.5
      const a = (0.65 + b * 0.35).toFixed(2)
      ctx.fillStyle = `rgba(0,255,204,${a})`
      ctx.fillRect(px + 2, py + 1, 4, 2)
      ctx.fillRect(px + 1, py + 3, 6, 2)
      ctx.fillRect(px + 2, py + 5, 4, 2)
      ctx.fillStyle = `rgba(200,255,255,${a})`
      ctx.fillRect(px + 3, py + 2, 2, 2)
      return
    }
    case 3:
      ctx.fillStyle = '#ff4400'
      ctx.fillRect(px + 3, py,     2, 2)
      ctx.fillRect(px + 2, py + 2, 4, 2)
      ctx.fillRect(px + 1, py + 4, 6, 4)
      return
    case 4: {
      const eb = (Math.sin(t * 0.12 + px) + 1) * 0.5
      ctx.fillStyle = '#ff55aa'
      ctx.fillRect(px + 1, py + 2, 6, 5)
      ctx.fillRect(px + 2, py + 1, 4, 1)
      ctx.fillStyle = `rgba(255,34,0,${0.7 + eb * 0.3})`
      ctx.fillRect(px + 2, py + 3, 1, 1)
      ctx.fillRect(px + 5, py + 3, 1, 1)
      return
    }
  }
}

function drawSprite(ctx: CanvasRenderingContext2D, frame: Frame, px: number, py: number) {
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      const c = frame[row][col]
      if (!c) continue
      ctx.fillStyle = c
      ctx.fillRect(px + col, py + row, 1, 1)
    }
}

// ── Keyboard → Move mapping ────────────────────────────────────────────────────
const KEY_MOVE: Record<string, Move> = {
  ArrowLeft:  1, a: 1, A: 1,
  ArrowRight: 2, d: 2, D: 2,
  ArrowUp:    3, w: 3, W: 3, ' ': 3,
  ArrowDown:  0,
  z: 4, Z: 4,
  x: 5, X: 5,
}

// ── Component ──────────────────────────────────────────────────────────────────
export function GameScreen({ runId, onBack }: Props) {
  const { run, state, refetch }  = useRun(runId)
  const fetchClearedGems         = useGemEventFetcher(runId)
  const [clearedGems, setClearedGems] = useState<Set<string>>(new Set())

  const {
    status: skStatus,
    error:  skError,
    sessionPrivateKey,
    generateAndAuthorize,
    reset: resetSK,
  } = useSessionKey(runId)

  const {
    submitMove,
    moveStatus,
    error: moveError,
    resetMove,
  } = useSubmitMove(runId, sessionPrivateKey)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef(0)
  const frameRef  = useRef(0)
  const stateRef  = useRef(state)
  stateRef.current = state
  const clearedRef = useRef(clearedGems)
  clearedRef.current = clearedGems

  // Load historical gem events on mount
  useEffect(() => {
    fetchClearedGems().then(setClearedGems)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refetch run state + gem events after each move confirms
  useEffect(() => {
    if (moveStatus === 'done') {
      Promise.all([refetch(), fetchClearedGems()]).then(([, gems]) => {
        setClearedGems(gems)
        resetMove()
      })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveStatus])

  // Keyboard controls — only when session key is ready and no move in-flight
  const canMove = skStatus === 'ready' && moveStatus === 'idle'
  const canMoveRef = useRef(canMove)
  canMoveRef.current = canMove

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!canMoveRef.current) return
      const move = KEY_MOVE[e.key]
      if (move === undefined) return
      e.preventDefault()
      submitMove(move)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitMove])

  // Canvas render loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx    = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    frameRef.current++
    const t  = frameRef.current
    const st = stateRef.current

    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#06060f'
    ctx.fillRect(0, 0, COLS * TILE, ROWS * TILE)

    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++) {
        const tile = clearedRef.current.has(`${x},${y}`) ? 0 : LEVEL[y][x]
        drawTile(ctx, tile, x * TILE, y * TILE, t)
      }

    const posX = Math.min(Math.max(st?.posX ?? 2, 0), COLS - 1)
    const posY = Math.min(Math.max(st?.posY ?? 14, 0), ROWS - 1)
    ctx.shadowColor = '#4499ff'
    ctx.shadowBlur  = 4
    drawSprite(ctx, CAPTAIN_FRAMES[(st?.animFrame ?? 0) % 2], posX * TILE, posY * TILE)
    ctx.shadowBlur = 0

    rafRef.current = requestAnimationFrame(draw)
  }, [])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  // ── HUD values ──────────────────────────────────────────────────────────────
  const hp       = state?.health ?? 3
  const hearts   = '♥'.repeat(hp) + '♡'.repeat(Math.max(0, 3 - hp))
  const score    = (state?.score ?? 0n).toString().padStart(6, '0')
  const tick     = run?.tick?.toString() ?? '0'
  const runEnded = run !== null && run?.active === false

  // Status line priority: move tx > session key
  const statusMsg = (() => {
    if (moveStatus === 'error' && moveError)    return moveError.slice(0, 100)
    if (moveStatus === 'sending')               return 'SENDING MOVE...'
    if (moveStatus === 'confirming')            return 'CONFIRMING TICK...'
    if (moveStatus === 'done')                  return 'TICK COMPLETE!'
    if (skStatus === 'error' && skError)        return skError.slice(0, 100)
    if (skStatus === 'authorizing')             return 'TX 1/2: SIGNING SESSION KEY...'
    if (skStatus === 'confirming')              return 'TX 1/2: CONFIRMING ON-CHAIN...'
    if (skStatus === 'funding')                 return 'TX 2/2: SEND GAS TO SESSION KEY...'
    if (skStatus === 'funding_confirm')         return 'TX 2/2: CONFIRMING FUNDING...'
    return ''
  })()

  const skBusy = skStatus === 'authorizing' || skStatus === 'confirming'
              || skStatus === 'funding'     || skStatus === 'funding_confirm'
  const moveBusy = moveStatus === 'sending' || moveStatus === 'confirming'

  function handleSessionKeyBtn() {
    if (skStatus === 'error') { resetSK(); return }
    generateAndAuthorize()
  }

  return (
    <div className="game-screen">

      {/* ── HUD ── */}
      <div className="game-hud">
        <span className="hud-run">RUN <em>#{runId.toString()}</em></span>
        <span className="hud-hp"><em>{hearts}</em></span>
        <span className="hud-score">SCORE <em>{score}</em></span>
        <span className="hud-tick">TICK <em>{tick}</em></span>
      </div>

      {/* ── Canvas ── */}
      <div className="game-canvas-wrap">
        <canvas
          ref={canvasRef}
          width={COLS * TILE}
          height={ROWS * TILE}
          className="game-canvas"
        />
      </div>

      {/* ── Status line ── */}
      <div className={`game-status ${moveStatus === 'error' || skStatus === 'error' ? 'err' : ''}`}>
        {statusMsg || '\u00a0'}
      </div>

      {/* ── Session key setup (shown until authorized) ── */}
      {!runEnded && skStatus !== 'ready' && (
        <div className="game-session-setup">
          <div className="session-hint">
            Sign once to set up a session key — then play without MetaMask popups.
          </div>
          <button
            className={`session-key-btn${skBusy ? ' busy' : ''}${skStatus === 'error' ? ' error' : ''}`}
            disabled={skBusy}
            onClick={handleSessionKeyBtn}
          >
            {skBusy
              ? (skStatus === 'funding' || skStatus === 'funding_confirm'
                  ? 'FUNDING KEY...'
                  : 'AUTHORIZING...')
              : skStatus === 'error'
                ? '✗ RETRY'
                : '⚡ AUTHORIZE SESSION KEY'}
          </button>
        </div>
      )}

      {/* ── Game over overlay ── */}
      {runEnded && (
        <div className="game-over">
          <div className="game-over-title">{hp > 0 ? 'YOU WIN!' : 'GAME OVER'}</div>
          <div className="game-over-score">FINAL SCORE: {score}</div>
          <button className="btn-back" onClick={onBack}>← play again</button>
        </div>
      )}

      {/* ── Move pad (only when session key ready) ── */}
      {!runEnded && skStatus === 'ready' && (
        <div className="game-movepad">
          {([1, 3, 2, 0, 4, 5] as Move[]).map(m => (
            <button
              key={m}
              className={`move-btn move-${m}`}
              disabled={moveBusy}
              onClick={() => submitMove(m)}
            >
              {MOVE_LABELS[m]}
            </button>
          ))}
        </div>
      )}

      {/* ── Footer ── */}
      <div className="game-footer">
        <button className="btn-back" onClick={onBack}>← abandon run</button>
      </div>

    </div>
  )
}
