import { useCallback, useEffect, useRef } from 'react'
import { useAccount } from 'wagmi'
import { useRun } from './useGameState'
import { useCommitReveal, Move, MOVE_LABELS, TX_STATUS_LABEL } from './useCommitReveal'

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
const CB = '#4499ff'  // cape blue
const CS = '#ffcc99'  // skin
const CG = '#ffdd00'  // gold D emblem
const CL = '#1155cc'  // dark legs

type Px = string | null
type Frame = Px[][]

const CAPTAIN_FRAMES: Frame[] = [
  // frame 0 — left foot
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
  // frame 1 — right foot
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

// ── Level layout ───────────────────────────────────────────────────────────────
// Hardcoded to match expected on-chain getTile layout (0=air,1=wall,2=gem,3=spike)
function buildLevel(): number[][] {
  const g = Array.from({ length: ROWS }, () => Array<number>(COLS).fill(0))

  // Floor
  for (let x = 0; x < COLS; x++) g[15][x] = 1

  // Platforms
  for (let x = 3;  x <= 9;  x++) g[11][x] = 1
  for (let x = 14; x <= 20; x++) g[9][x]  = 1
  for (let x = 24; x <= 30; x++) g[11][x] = 1
  for (let x = 8;  x <= 14; x++) g[7][x]  = 1
  for (let x = 18; x <= 25; x++) g[6][x]  = 1
  for (let x = 0;  x <= 5;  x++) g[6][x]  = 1

  // Gems
  for (const [y, x] of [[10,6],[10,8],[8,17],[8,19],[10,27],[6,11],[6,13],[5,21],[5,23],[5,2],[5,4]])
    g[y][x] = 2

  // Spikes
  for (const [y, x] of [[14,5],[14,6],[14,18],[14,25],[14,26]])
    g[y][x] = 3

  return g
}

const LEVEL = buildLevel()

// ── Drawing helpers ────────────────────────────────────────────────────────────
function drawTile(ctx: CanvasRenderingContext2D, tile: number, px: number, py: number, t: number) {
  switch (tile) {
    case 0: return
    case 1:  // wall / platform
      ctx.fillStyle = '#1a2a4e'
      ctx.fillRect(px, py, TILE, TILE)
      ctx.fillStyle = '#2a3d72'
      ctx.fillRect(px, py, TILE, 1)
      ctx.fillRect(px, py, 1, TILE)
      ctx.fillStyle = '#0d1a30'
      ctx.fillRect(px, py + TILE - 1, TILE, 1)
      return
    case 2: {  // Magical D gem — pulses
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
    case 3:  // spike
      ctx.fillStyle = '#ff4400'
      ctx.fillRect(px + 3, py,     2, 2)
      ctx.fillRect(px + 2, py + 2, 4, 2)
      ctx.fillRect(px + 1, py + 4, 6, 4)
      return
    case 4:  // enemy marker
      ctx.fillStyle = '#ff55aa'
      ctx.fillRect(px + 1, py + 1, TILE - 2, TILE - 2)
      return
  }
}

function drawSprite(ctx: CanvasRenderingContext2D, frame: Frame, px: number, py: number) {
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const c = frame[row][col]
      if (!c) continue
      ctx.fillStyle = c
      ctx.fillRect(px + col, py + row, 1, 1)
    }
  }
}

// ── Component ──────────────────────────────────────────────────────────────────
export function GameScreen({ runId, onBack }: Props) {
  const { address } = useAccount()
  const { run, state, refetch } = useRun(runId)
  const { submitMove, txStatus, error, reset } = useCommitReveal(runId, address)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const rafRef    = useRef(0)
  const frameRef  = useRef(0)   // animation tick counter
  const stateRef  = useRef(state)
  stateRef.current = state

  // Refetch and reset after each reveal
  useEffect(() => {
    if (txStatus === 'done') {
      refetch().then(() => reset())
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [txStatus])

  // Canvas render loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    frameRef.current++
    const t  = frameRef.current
    const st = stateRef.current

    ctx.imageSmoothingEnabled = false
    ctx.fillStyle = '#06060f'
    ctx.fillRect(0, 0, COLS * TILE, ROWS * TILE)

    // Tiles
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        drawTile(ctx, LEVEL[y][x], x * TILE, y * TILE, t)

    // Player
    const posX = Math.min(Math.max(st?.posX ?? 1, 0), COLS - 1)
    const posY = Math.min(Math.max(st?.posY ?? 13, 0), ROWS - 1)
    const animF = st?.animFrame ?? 0
    ctx.shadowColor = '#4499ff'
    ctx.shadowBlur  = 4
    drawSprite(ctx, CAPTAIN_FRAMES[animF % 2], posX * TILE, posY * TILE)
    ctx.shadowBlur = 0

    rafRef.current = requestAnimationFrame(draw)
  }, [])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  const busy   = txStatus !== 'idle' && txStatus !== 'done' && txStatus !== 'error'
  const active = run?.active ?? true   // assume active until data loads
  const hp     = state?.health ?? '?'
  const score  = state?.score?.toString().padStart(6, '0') ?? '000000'
  const tick   = run?.tick?.toString() ?? '0'

  const statusMsg = txStatus === 'error' && error
    ? error.slice(0, 100)
    : TX_STATUS_LABEL[txStatus]

  const runEnded = run !== null && run?.active === false

  return (
    <div className="game-screen">

      {/* ── HUD ── */}
      <div className="game-hud">
        <span className="hud-run">RUN #{runId.toString()}</span>
        <span className="hud-hp">HP <em>{hp}</em></span>
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

      {/* ── Status ── */}
      <div className={`game-status ${txStatus === 'error' ? 'err' : ''}`}>
        {statusMsg || '\u00a0'}
      </div>

      {/* ── Run ended overlay ── */}
      {runEnded && (
        <div className="game-over">
          <div className="game-over-title">
            {(state?.health ?? 1) > 0 ? 'YOU WIN!' : 'GAME OVER'}
          </div>
          <div className="game-over-score">FINAL SCORE: {score}</div>
        </div>
      )}

      {/* ── Move pad ── */}
      {!runEnded && (
        <div className="game-movepad">
          {([1, 3, 2, 0, 4, 5] as Move[]).map(m => (
            <button
              key={m}
              className={`move-btn move-${m}`}
              disabled={busy || !active}
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
