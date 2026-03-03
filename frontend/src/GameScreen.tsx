import { useCallback, useEffect, useRef } from 'react'
import { useRun, useGemEventFetcher } from './useGameState'
import { useSessionKey } from './useSessionKey'
import { useLocalPhysics } from './useLocalPhysics'
import { useMoveQueue } from './useMoveQueue'
import { loadSpriteSheet } from './removeBackground'
import { LEVEL_MAP, LEVEL_WIDTH, Move } from './physics'
import type { Move as MoveType } from './physics'
import { MOVE_LABELS } from './useSubmitMove'

interface Props {
  runId: bigint
  onBack: () => void
}

// ── Canvas config ──────────────────────────────────────────────────────────────
const TILE = 8
const COLS = 32
const ROWS = 16

// ── Captain spritesheet layout (832×1248, 3 cols × 4 rows) ───────────────────
const CELL_W = 277
const CELL_H = 312
const WALK_FRAMES = [0, 1, 2, 3, 4, 5].map(i => ({
  sx: (i % 3) * CELL_W, sy: Math.floor(i / 3) * CELL_H, sw: CELL_W, sh: CELL_H,
}))
const PUNCH_FRAME = { sx: 0,      sy: CELL_H * 2, sw: CELL_W, sh: CELL_H }
const KICK_FRAME  = { sx: CELL_W, sy: CELL_H * 2, sw: CELL_W, sh: CELL_H }
const JUMP_FRAME  = { sx: CELL_W, sy: CELL_H * 3, sw: CELL_W, sh: CELL_H }
const SPR_W = TILE * 2
const SPR_H = TILE * 3

// ── Enemy spritesheet layout (4 cols × 3 rows) ────────────────────────────────
// Row 0: troll walk cycle (4 frames)
// Row 1: troll bat-attack cycle (4 frames)  — used for active/alerted state
// Row 2: old man idle cycle (4 frames)
// Cell dimensions computed at runtime from loaded image size
const ENEMY_COLS = 4
const ENEMY_ROWS = 3

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

function drawCaptain(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLCanvasElement,
  animFrame: number,
  lastMove: MoveType | null,
  px: number,
  py: number,
) {
  let frame = WALK_FRAMES[animFrame % WALK_FRAMES.length]
  if (lastMove === Move.Punch) frame = PUNCH_FRAME
  else if (lastMove === Move.Kick) frame = KICK_FRAME
  else if (lastMove === Move.Jump) frame = JUMP_FRAME
  ctx.drawImage(sheet, frame.sx, frame.sy, frame.sw, frame.sh,
    px - TILE / 2, py - SPR_H + TILE, SPR_W, SPR_H)
}

function drawEnemy(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLCanvasElement,
  t: number,
  px: number,
  py: number,
) {
  const cw = sheet.width  / ENEMY_COLS
  const ch = sheet.height / ENEMY_ROWS
  const col = Math.floor(t / 8) % ENEMY_COLS   // advance frame every 8 canvas ticks
  const sx  = col * cw
  const sy  = 0                                 // row 0 = troll walk
  ctx.drawImage(sheet, sx, sy, cw, ch, px - TILE / 2, py - SPR_H + TILE, SPR_W, SPR_H)
}

// ── Keyboard → Move mapping ────────────────────────────────────────────────────
const KEY_MOVE: Record<string, MoveType> = {
  ArrowLeft:  Move.Left,  a: Move.Left,  A: Move.Left,
  ArrowRight: Move.Right, d: Move.Right, D: Move.Right,
  ArrowUp:    Move.Jump,  w: Move.Jump,  W: Move.Jump, ' ': Move.Jump,
  ArrowDown:  Move.Idle,
  z: Move.Punch, Z: Move.Punch,
  x: Move.Kick,  X: Move.Kick,
}

// ── Component ──────────────────────────────────────────────────────────────────
export function GameScreen({ runId, onBack }: Props) {
  const { run, refetch }         = useRun(runId)
  const fetchClearedGems         = useGemEventFetcher(runId)

  const {
    status: skStatus,
    error:  skError,
    sessionPrivateKey,
    generateAndAuthorize,
    reset: resetSK,
  } = useSessionKey(runId)

  // ── Local physics (60fps, instant feedback) ──────────────────────────────────
  const { localState, applyMove, syncFromChain, desynced } = useLocalPhysics(
    run?.playerState
  )

  // ── Move queue (batches moves, submits to chain) ──────────────────────────────
  const handleBatchConfirmed = useCallback(() => {
    // After batch confirms, refetch chain state and reconcile
    Promise.all([refetch(), fetchClearedGems()]).then(([result, clearedStrings]) => {
      const data = result.data
      if (!data || data[4] === undefined) return
      const chainPlayerState = data[4] as bigint
      const chainTick        = Number(data[3])
      // Convert Set<string> "x,y" → Set<number> row-major idx
      const idxSet = new Set<number>()
      clearedStrings.forEach(k => {
        const [x, y] = k.split(',').map(Number)
        idxSet.add(y * LEVEL_WIDTH + x)
      })
      syncFromChain(chainPlayerState, chainTick, idxSet)
    })
  }, [refetch, fetchClearedGems, syncFromChain])

  const { enqueue, batchStatus, batchError, pendingCount, flushNow } = useMoveQueue({
    runId,
    sessionPrivateKey: sessionPrivateKey ?? null,
    onBatchConfirmed: handleBatchConfirmed,
    enabled: skStatus === 'ready',
  })

  // ── Canvas refs ───────────────────────────────────────────────────────────────
  const canvasRef   = useRef<HTMLCanvasElement>(null)
  const rafRef      = useRef(0)
  const frameRef    = useRef(0)
  const localRef    = useRef(localState)
  localRef.current  = localState
  const spriteRef      = useRef<HTMLCanvasElement | null>(null)
  const enemySheetRef  = useRef<HTMLCanvasElement | null>(null)
  const bgRef          = useRef<HTMLImageElement | null>(null)
  const lastMoveRef    = useRef<MoveType | null>(null)

  // Load sprite sheets with background removal + background image
  useEffect(() => {
    loadSpriteSheet('/sprites/captain-normal.png').then(c => { spriteRef.current = c })
    loadSpriteSheet('/sprites/enemy-troll.png').then(c => { enemySheetRef.current = c })
    const bg = new Image()
    bg.src = '/sprites/background.png'
    bg.onload = () => { bgRef.current = bg }
  }, [])

  // Flush queue when run ends
  useEffect(() => {
    if (!localState.active) flushNow()
  }, [localState.active, flushNow])

  // ── Keyboard controls ─────────────────────────────────────────────────────────
  const canMove    = skStatus === 'ready' && localState.active
  const canMoveRef = useRef(canMove)
  canMoveRef.current = canMove

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!canMoveRef.current) return
      const move = KEY_MOVE[e.key]
      if (move === undefined) return
      e.preventDefault()
      lastMoveRef.current = move
      applyMove(move)   // instant local physics
      enqueue(move)     // queued for chain
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyMove, enqueue])

  // ── Canvas render loop (reads localState, not chain) ──────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const ctx    = canvas?.getContext('2d')
    if (!ctx || !canvas) return

    frameRef.current++
    const t  = frameRef.current
    const ls = localRef.current

    ctx.imageSmoothingEnabled = false

    // Draw background image, or solid fallback
    const bg = bgRef.current
    if (bg) {
      ctx.drawImage(bg, 0, 0, COLS * TILE, ROWS * TILE)
    } else {
      ctx.fillStyle = '#06060f'
      ctx.fillRect(0, 0, COLS * TILE, ROWS * TILE)
    }

    // Draw tiles — use local clearedTiles set; enemy tiles use spritesheet
    const enemySheet = enemySheetRef.current
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++) {
        const idx  = y * LEVEL_WIDTH + x
        const tile = ls.clearedTiles.has(idx) ? 0 : LEVEL_MAP[idx]
        if (tile === 4 && enemySheet) {
          drawEnemy(ctx, enemySheet, t, x * TILE, y * TILE)
        } else {
          drawTile(ctx, tile, x * TILE, y * TILE, t)
        }
      }

    // Draw captain from local physics position
    const posX = Math.min(Math.max(ls.player.posX, 0), COLS - 1)
    const posY = Math.min(Math.max(ls.player.posY, 0), ROWS - 1)
    const sheet = spriteRef.current
    if (sheet) {
      ctx.shadowColor = '#4499ff'
      ctx.shadowBlur  = 6
      drawCaptain(ctx, sheet, ls.player.animFrame, lastMoveRef.current, posX * TILE, posY * TILE)
      ctx.shadowBlur  = 0
    }

    rafRef.current = requestAnimationFrame(draw)
  }, [])

  useEffect(() => {
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw])

  // ── HUD values (from local state) ─────────────────────────────────────────────
  const hp       = localState.player.health
  const hearts   = '♥'.repeat(hp) + '♡'.repeat(Math.max(0, 3 - hp))
  const score    = localState.player.score.toString().padStart(6, '0')
  const tick     = localState.tick.toString()
  const runEnded = !localState.active

  // Status line — batch status takes priority over session key status
  const statusMsg = (() => {
    if (batchStatus === 'error' && batchError)  return batchError.slice(0, 100)
    if (batchStatus === 'sending')              return `SENDING ${pendingCount} MOVES...`
    if (batchStatus === 'confirming')           return 'CONFIRMING ON CHAIN...'
    if (batchStatus === 'done')                 return 'BATCH CONFIRMED ✓'
    if (desynced)                               return 'SYNCED TO CHAIN'
    if (pendingCount > 0)                       return `${pendingCount} MOVE${pendingCount > 1 ? 'S' : ''} QUEUED`
    if (skStatus === 'error' && skError)        return skError.slice(0, 100)
    if (skStatus === 'authorizing')             return 'TX 1/2: SIGNING SESSION KEY...'
    if (skStatus === 'confirming')              return 'TX 1/2: CONFIRMING ON-CHAIN...'
    if (skStatus === 'funding')                 return 'TX 2/2: SEND GAS TO SESSION KEY...'
    if (skStatus === 'funding_confirm')         return 'TX 2/2: CONFIRMING FUNDING...'
    return ''
  })()

  const skBusy   = skStatus === 'authorizing' || skStatus === 'confirming'
                || skStatus === 'funding'     || skStatus === 'funding_confirm'

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
      <div className={`game-status ${batchStatus === 'error' || skStatus === 'error' ? 'err' : ''}`}>
        {statusMsg || '\u00a0'}
      </div>

      {/* ── Session key setup ── */}
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
          <div className="game-over-title">{localState.won ? 'YOU WIN!' : 'GAME OVER'}</div>
          <div className="game-over-score">FINAL SCORE: {score}</div>
          <button className="btn-back" onClick={onBack}>← play again</button>
        </div>
      )}

      {/* ── Move pad ── */}
      {!runEnded && skStatus === 'ready' && (
        <div className="game-movepad">
          {([Move.Left, Move.Jump, Move.Right, Move.Idle, Move.Punch, Move.Kick] as MoveType[]).map(m => (
            <button
              key={m}
              className={`move-btn move-${m}`}
              onClick={() => {
                if (!canMove) return
                lastMoveRef.current = m
                applyMove(m)
                enqueue(m)
              }}
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
