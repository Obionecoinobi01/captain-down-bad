import { useCallback, useEffect, useRef } from 'react'
import { initRetroGL, DEFAULT_RETRO, type RetroGL } from './effects'
import {
  startMusic, stopMusic,
  playGemCollect, playJump, playPunch, playKick,
  playHurt, playEnemyDefeat, playGameOver, playWin,
} from './sound'
import { useRun, useGemEventFetcher } from './useGameState'
import { useSessionKey } from './useSessionKey'
import { useLocalPhysics } from './useLocalPhysics'
import { useMoveQueue } from './useMoveQueue'
import { loadSpriteSheet } from './removeBackground'
import { LEVEL_MAP, LEVEL_WIDTH, Move, getEnemyPositions } from './physics'
import type { Move as MoveType } from './physics'
import { publicClient, CONTRACT_ADDRESS } from './wagmi'
import { CDB_ABI } from './abi'
import { MOVE_LABELS } from './useSubmitMove'

interface Props {
  runId: bigint
  onBack: () => void
}

// ── Canvas config ──────────────────────────────────────────────────────────────
const TILE       = 16          // px per tile — doubled from 8 for crisp detail
const COLS       = 32          // level columns (physics / contract)
const ROWS       = 16          // level rows    (physics / contract)
const VIEWPORT_W = 20          // tiles visible horizontally (scrolling camera)
const VIEWPORT_H = 12          // tiles visible vertically
const CANVAS_W   = VIEWPORT_W * TILE   // 320
const CANVAS_H   = VIEWPORT_H * TILE   // 192

// ── Captain spritesheet layout (832×1248, 3 cols × 4 rows) ───────────────────
const CELL_W = 277
const CELL_H = 312
const WALK_FRAMES = [0, 1, 2, 3, 4, 5].map(i => ({
  sx: (i % 3) * CELL_W, sy: Math.floor(i / 3) * CELL_H, sw: CELL_W, sh: CELL_H,
}))
// Action frames from captain_actions.png (832×624, 3 cols × 2 rows)
// Row 0: punch, kick, jump  |  Row 1: hurt, idle, land
const PUNCH_FRAME = { sx: 0,          sy: 0,      sw: CELL_W, sh: CELL_H }
const KICK_FRAME  = { sx: CELL_W,     sy: 0,      sw: CELL_W, sh: CELL_H }
const JUMP_FRAME  = { sx: CELL_W * 2, sy: 0,      sw: CELL_W, sh: CELL_H }
const HURT_FRAME  = { sx: 0,          sy: CELL_H, sw: CELL_W, sh: CELL_H }
const SPR_W = TILE * 2   // 32px
const SPR_H = TILE * 3   // 48px

// ── Enemy spritesheet layout (3 cols × 4 rows, 832×1248) ─────────────────────
// Row 0: walk cycle frames 0-2
// Row 1: attack cycle frames 0-2
// Row 2: idle frames 0-2
// Row 3: defeat frames 0-2
// Cell dimensions computed at runtime from loaded image size
const ENEMY_COLS = 3
const ENEMY_ROWS = 4

// ── Drawing helpers ────────────────────────────────────────────────────────────
function drawTile(ctx: CanvasRenderingContext2D, tile: number, px: number, py: number, t: number) {
  const s = TILE / 8   // scale factor: 2 when TILE=16
  switch (tile) {
    case 0: return
    case 1:
      ctx.fillStyle = '#1a2a4e'
      ctx.fillRect(px, py, TILE, TILE)
      ctx.fillStyle = '#2a3d72'
      ctx.fillRect(px, py,            TILE, s)
      ctx.fillRect(px, py,            s,    TILE)
      ctx.fillStyle = '#0d1a30'
      ctx.fillRect(px, py + TILE - s, TILE, s)
      return
    case 2: {
      const b = (Math.sin(t * 0.08 + px * 0.4) + 1) * 0.5
      const a = (0.65 + b * 0.35).toFixed(2)
      ctx.fillStyle = `rgba(0,255,204,${a})`
      ctx.fillRect(px + 2*s, py + 1*s, 4*s, 2*s)
      ctx.fillRect(px + 1*s, py + 3*s, 6*s, 2*s)
      ctx.fillRect(px + 2*s, py + 5*s, 4*s, 2*s)
      ctx.fillStyle = `rgba(200,255,255,${a})`
      ctx.fillRect(px + 3*s, py + 2*s, 2*s, 2*s)
      return
    }
    case 3:
      ctx.fillStyle = '#ff4400'
      ctx.fillRect(px + 3*s, py,       2*s, 2*s)
      ctx.fillRect(px + 2*s, py + 2*s, 4*s, 2*s)
      ctx.fillRect(px + 1*s, py + 4*s, 6*s, 4*s)
      return
    case 4: {
      const eb = (Math.sin(t * 0.12 + px) + 1) * 0.5
      ctx.fillStyle = '#ff55aa'
      ctx.fillRect(px + 1*s, py + 2*s, 6*s, 5*s)
      ctx.fillRect(px + 2*s, py + 1*s, 4*s, 1*s)
      ctx.fillStyle = `rgba(255,34,0,${0.7 + eb * 0.3})`
      ctx.fillRect(px + 2*s, py + 3*s, 1*s, 1*s)
      ctx.fillRect(px + 5*s, py + 3*s, 1*s, 1*s)
      return
    }
  }
}

function drawCaptain(
  ctx: CanvasRenderingContext2D,
  walkSheet: HTMLCanvasElement,
  actSheet: HTMLCanvasElement | null,
  t: number,
  lastMove: MoveType | null,
  px: number,
  py: number,
  facing: number,   // 1 = right, -1 = left
) {
  let frame: typeof PUNCH_FRAME
  let src: HTMLCanvasElement
  if (lastMove === Move.Punch && actSheet) { frame = PUNCH_FRAME; src = actSheet }
  else if (lastMove === Move.Kick && actSheet)  { frame = KICK_FRAME;  src = actSheet }
  else if (lastMove === Move.Jump && actSheet)  { frame = JUMP_FRAME;  src = actSheet }
  else { frame = WALK_FRAMES[Math.floor(t / 6) % WALK_FRAMES.length]; src = walkSheet }

  const dx = px - TILE / 2
  const dy = py - SPR_H + TILE
  ctx.save()
  if (facing === -1) {
    ctx.translate(dx + SPR_W, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(src, frame.sx, frame.sy, frame.sw, frame.sh, 0, dy, SPR_W, SPR_H)
  } else {
    ctx.drawImage(src, frame.sx, frame.sy, frame.sw, frame.sh, dx, dy, SPR_W, SPR_H)
  }
  ctx.restore()
}

function drawEnemy(
  ctx: CanvasRenderingContext2D,
  sheet: HTMLCanvasElement,
  t: number,
  px: number,
  py: number,
  row: number = 0,    // 0 = walk, 1 = attack, 2 = idle
  facing: number = 1, // 1 = right, -1 = left
) {
  const cw  = sheet.width  / ENEMY_COLS
  const ch  = sheet.height / ENEMY_ROWS
  const col = Math.floor(t / 8) % ENEMY_COLS   // advance frame every 8 canvas ticks
  const sx  = col * cw
  const sy  = row * ch
  const dx  = px - TILE / 2
  const dy  = py - SPR_H + TILE
  ctx.save()
  if (facing === -1) {
    ctx.translate(dx + SPR_W, 0)
    ctx.scale(-1, 1)
    ctx.drawImage(sheet, sx, sy, cw, ch, 0, dy, SPR_W, SPR_H)
  } else {
    ctx.drawImage(sheet, sx, sy, cw, ch, dx, dy, SPR_W, SPR_H)
  }
  ctx.restore()
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
    Promise.all([
      refetch(),
      fetchClearedGems(),
      publicClient.readContract({
        address:      CONTRACT_ADDRESS,
        abi:          CDB_ABI,
        functionName: 'enemyDefeated',
        args:         [runId],
      }) as Promise<number>,
    ]).then(([result, clearedStrings, chainEnemiesDefeated]) => {
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
      syncFromChain(chainPlayerState, chainTick, idxSet, Number(chainEnemiesDefeated))
    })
  }, [refetch, fetchClearedGems, syncFromChain, runId])

  const { enqueue, batchStatus, batchError, pendingCount, flushNow } = useMoveQueue({
    runId,
    sessionPrivateKey: sessionPrivateKey ?? null,
    onBatchConfirmed: handleBatchConfirmed,
    enabled: skStatus === 'ready',
  })

  // ── Canvas refs ───────────────────────────────────────────────────────────────
  const canvasRef   = useRef<HTMLCanvasElement>(null)   // Canvas 2D — hidden, source texture
  const glCanvasRef = useRef<HTMLCanvasElement>(null)   // WebGL — visible display
  const glStateRef  = useRef<RetroGL | null>(null)
  const rafRef      = useRef(0)
  const frameRef    = useRef(0)
  const localRef    = useRef(localState)
  localRef.current  = localState
  const spriteRef      = useRef<HTMLCanvasElement | null>(null)   // captain walk sheet
  const actionsRef     = useRef<HTMLCanvasElement | null>(null)   // captain actions sheet
  const enemySheetRef  = useRef<HTMLCanvasElement | null>(null)   // troll
  const demonSheetRef  = useRef<HTMLCanvasElement | null>(null)   // demon
  const bossSheetRef   = useRef<HTMLCanvasElement | null>(null)   // cosmic dancer boss
  const bossStateRef   = useRef<{ active: boolean; tick: number; phase: 'enter'|'idle'|'attack'|'exit' }>({
    active: false, tick: 0, phase: 'enter'
  })
  const bgRef          = useRef<HTMLImageElement | null>(null)
  const lastMoveRef    = useRef<MoveType | null>(null)

  // ── Post-processing state ──────────────────────────────────────────────────
  const hitFlashRef    = useRef(0)                         // white flash on damage
  const defFlashRef    = useRef(0)                         // cyan flash on enemy kill
  const glitchRef      = useRef(0)                         // glitch burst on game over
  const shakeRef       = useRef({ x: 0, y: 0, ttl: 0 })  // screen shake state
  const prevHealthRef  = useRef(3)
  const prevEnemiesRef = useRef(0)
  const prevScoreRef   = useRef(0)
  const cameraRef      = useRef({ x: 0, y: 0 })           // smooth-follow camera (tile units)
  const facingRef      = useRef(1)                         // captain facing: 1=right, -1=left

  // Init WebGL post-processing
  useEffect(() => {
    const canvas = glCanvasRef.current
    if (!canvas) return
    glStateRef.current = initRetroGL(canvas)
    return () => { glStateRef.current?.dispose(); glStateRef.current = null }
  }, [])

  // Game music — start intense variant when screen mounts, stop on unmount
  useEffect(() => {
    startMusic('game')
    return () => stopMusic()
  }, [])

  // Load sprite sheets with background removal + background image
  useEffect(() => {
    loadSpriteSheet('/img/sprites/captain_1.png').then(c => { spriteRef.current = c })
    loadSpriteSheet('/img/sprites/captain_actions.png').then(c => { actionsRef.current = c })
    loadSpriteSheet('/img/sprites/enemy_troll_new.png').then(c => { enemySheetRef.current = c })
    loadSpriteSheet('/img/sprites/enemy_demon_new.png').then(c => { demonSheetRef.current = c })
    loadSpriteSheet('/img/sprites/boss_dancer.png').then(c => { bossSheetRef.current = c })
    const bg = new Image()
    bg.src = '/img/background_new.png'
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
      if (move === Move.Left)  facingRef.current = -1
      if (move === Move.Right) facingRef.current =  1
      if (move === Move.Jump)  playJump()
      if (move === Move.Punch) playPunch()
      if (move === Move.Kick)  playKick()
      applyMove(move)   // instant local physics
      enqueue(move)     // queued for chain
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyMove, enqueue])

  // ── Canvas render loop (reads localState, not chain) ──────────────────────────
  const draw = useCallback(() => {
    const canvas   = canvasRef.current
    const ctx      = canvas?.getContext('2d')
    const glCanvas = glCanvasRef.current
    const retro    = glStateRef.current
    if (!ctx || !canvas) { rafRef.current = requestAnimationFrame(draw); return }

    frameRef.current++
    const t  = frameRef.current
    const ls = localRef.current

    // ── Detect game events ────────────────────────────────────────────────────
    const hp    = ls.player.health
    const score = ls.player.score
    const defs  = ls.enemiesDefeated

    if (hp < prevHealthRef.current) {
      // Damage taken — white flash + screen shake + hurt SFX
      hitFlashRef.current = 0.92
      shakeRef.current    = {
        x:   (Math.random() - 0.5) * 8,
        y:   (Math.random() - 0.5) * 5,
        ttl: 12,
      }
      playHurt()
    }
    prevHealthRef.current = hp

    if (defs > prevEnemiesRef.current) {
      // Enemy killed — cyan flash + SFX
      defFlashRef.current = 0.85
      playEnemyDefeat()
    }
    prevEnemiesRef.current = defs

    // Gem collected = score increased but enemy count unchanged
    if (score > prevScoreRef.current && defs === prevEnemiesRef.current) {
      playGemCollect()
    }
    prevScoreRef.current = score

    if (!ls.active && glitchRef.current === 0) {
      // Run ended — glitch burst + music stop + win/gameover jingle
      glitchRef.current = 1.0
      stopMusic()
      if (ls.won) playWin()
      else        playGameOver()
    }

    // ── Screen shake translate ────────────────────────────────────────────────
    const shake    = shakeRef.current
    const shaking  = shake.ttl > 0
    if (shaking) {
      ctx.save()
      ctx.translate(shake.x, shake.y)
      shake.ttl--
      if (shake.ttl > 0) {
        const decay = shake.ttl / 12
        shake.x = (Math.random() - 0.5) * 8 * decay
        shake.y = (Math.random() - 0.5) * 5 * decay
      } else {
        shake.x = 0; shake.y = 0
      }
    }

    ctx.imageSmoothingEnabled = false

    // ── Smooth-follow camera ──────────────────────────────────────────────────
    const posX = Math.min(Math.max(ls.player.posX, 0), COLS - 1)
    const posY = Math.min(Math.max(ls.player.posY, 0), ROWS - 1)
    const cam  = cameraRef.current
    const targetCX = Math.max(0, Math.min(COLS - VIEWPORT_W, posX - VIEWPORT_W / 2))
    const targetCY = Math.max(0, Math.min(ROWS - VIEWPORT_H, posY - VIEWPORT_H / 2))
    cam.x += (targetCX - cam.x) * 0.15
    cam.y += (targetCY - cam.y) * 0.15
    const ox = -cam.x * TILE   // pixel offset X
    const oy = -cam.y * TILE   // pixel offset Y

    // Draw background image, or solid fallback
    const bg = bgRef.current
    if (bg) {
      // Tile the background across the full level, then clip to viewport
      ctx.drawImage(bg,
        cam.x / COLS * bg.naturalWidth,  cam.y / ROWS * bg.naturalHeight,
        (VIEWPORT_W / COLS) * bg.naturalWidth, (VIEWPORT_H / ROWS) * bg.naturalHeight,
        0, 0, CANVAS_W, CANVAS_H)
    } else {
      ctx.fillStyle = '#06060f'
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    }

    // Draw only tiles in the viewport (+1 tile buffer each side to hide seams)
    const x0 = Math.floor(cam.x)
    const y0 = Math.floor(cam.y)
    for (let y = y0; y <= y0 + VIEWPORT_H + 1; y++) {
      for (let x = x0; x <= x0 + VIEWPORT_W + 1; x++) {
        if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue
        const idx  = y * LEVEL_WIDTH + x
        const tile = ls.clearedTiles.has(idx) ? 0 : LEVEL_MAP[idx]
        drawTile(ctx, tile, x * TILE + ox, y * TILE + oy, t)
      }
    }

    // Draw captain
    const sheet = spriteRef.current
    if (sheet) {
      ctx.shadowColor = '#4499ff'
      ctx.shadowBlur  = 8
      drawCaptain(ctx, sheet, actionsRef.current, t, lastMoveRef.current,
        posX * TILE + ox, posY * TILE + oy, facingRef.current)
      ctx.shadowBlur  = 0
    }

    // Draw dynamic enemies — cull those outside viewport
    const enemySheet = enemySheetRef.current
    const demonSheet = demonSheetRef.current
    if (enemySheet) {
      const enemies = getEnemyPositions(ls.enemiesDefeated, ls.tick)
      enemies.forEach((e, i) => {
        if (!e.alive) return
        const esx = e.posX * TILE + ox
        const esy = e.posY * TILE + oy
        if (esx < -TILE * 2 || esx > CANVAS_W + TILE) return
        if (esy < -TILE * 2 || esy > CANVAS_H + TILE) return
        const adjacent = Math.abs(e.posX - posX) <= 1 && e.posY === posY
        const row = adjacent ? 1 : 0    // row 1 = attack, row 0 = walk
        // Alternate enemy types: even index = troll, odd index = demon
        const sheet = (i % 2 === 1 && demonSheet) ? demonSheet : enemySheet
        ctx.shadowColor = i % 2 === 1 ? '#ff2200' : '#ff44aa'
        ctx.shadowBlur  = 6
        drawEnemy(ctx, sheet, t, esx, esy, row, e.facing)
        ctx.shadowBlur  = 0
      })
    }

    // ── Boss: Cosmic Dancer — appears at end of every round ───────────────────
    const bossSheet = bossSheetRef.current
    const boss = bossStateRef.current
    const score = Number((ls.playerState >> BigInt(0)) & BigInt(0xFFFFFFFFFFFFFF))
    // Trigger boss every 5 gems collected (score increments by 10 per gem)
    const roundEnd = score > 0 && score % 50 === 0
    if (roundEnd && !boss.active) {
      boss.active = true; boss.tick = 0; boss.phase = 'enter'
    }
    if (boss.active) {
      boss.tick++
      // Phase transitions
      if (boss.phase === 'enter'  && boss.tick > 60)  { boss.phase = 'attack'; boss.tick = 0 }
      if (boss.phase === 'attack' && boss.tick > 90)  { boss.phase = 'idle';   boss.tick = 0 }
      if (boss.phase === 'idle'   && boss.tick > 60)  { boss.phase = 'exit';   boss.tick = 0 }
      if (boss.phase === 'exit'   && boss.tick > 60)  { boss.active = false;   boss.tick = 0 }

      if (bossSheet) {
        const BOSS_W = SPR_W * 4   // 4× normal size
        const BOSS_H = SPR_H * 4
        const bx = (CANVAS_W - BOSS_W) / 2
        const by = (CANVAS_H - BOSS_H) / 2 - TILE * 2
        const rowMap = { enter: 2, idle: 0, attack: 1, exit: 3 } as const
        const row  = rowMap[boss.phase]
        const col  = Math.floor(boss.tick / 12) % 3
        const cw   = bossSheet.width  / 3
        const ch   = bossSheet.height / 4
        // Pulsing purple glow
        const pulse = (Math.sin(boss.tick * 0.1) + 1) * 0.5
        ctx.shadowColor = '#9933ff'
        ctx.shadowBlur  = 20 + pulse * 20
        // Fade in/out on enter/exit
        const alpha = boss.phase === 'enter' ? Math.min(1, boss.tick / 40)
                    : boss.phase === 'exit'  ? Math.max(0, 1 - boss.tick / 40) : 1
        ctx.globalAlpha = alpha
        ctx.drawImage(bossSheet, col * cw, row * ch, cw, ch, bx, by, BOSS_W, BOSS_H)
        ctx.globalAlpha = 1
        ctx.shadowBlur  = 0

        // Boss nameplate — "COSMIC DANCER" warning banner
        if (boss.phase === 'enter' || boss.phase === 'attack') {
          ctx.fillStyle = `rgba(153,51,255,${alpha * 0.85})`
          ctx.fillRect(0, CANVAS_H / 2 - 28, CANVAS_W, 22)
          ctx.fillStyle = '#ffffff'
          ctx.font = 'bold 11px monospace'
          ctx.textAlign = 'center'
          ctx.fillText('⚠  Euphoria!  ⚠', CANVAS_W / 2, CANVAS_H / 2 - 11)
          ctx.fillStyle = '#ffccff'
          ctx.font = '8px monospace'
          ctx.fillText("Captain Down Bad's greatest weakness...", CANVAS_W / 2, CANVAS_H / 2 + 2)
          ctx.textAlign = 'left'
        }
      }
    }

    // Restore transform after shake
    if (shaking) ctx.restore()

    // ── WebGL post-processing pass ────────────────────────────────────────────
    if (retro && glCanvas) {
      hitFlashRef.current = Math.max(0, hitFlashRef.current - 0.10)
      defFlashRef.current = Math.max(0, defFlashRef.current - 0.09)
      glitchRef.current   = Math.max(0, glitchRef.current   - 0.006)

      retro.render(canvas, {
        ...DEFAULT_RETRO,
        time:     performance.now() / 1000,
        hitFlash: hitFlashRef.current,
        defFlash: defFlashRef.current,
        glitch:   glitchRef.current,
      })
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
        {/* Canvas 2D — hidden, used as source texture for WebGL */}
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          style={{ display: 'none' }}
        />
        {/* WebGL display canvas — retro post-processing applied here */}
        <canvas
          ref={glCanvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
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
                if (m === Move.Left)  facingRef.current = -1
                if (m === Move.Right) facingRef.current =  1
                if (m === Move.Jump)  playJump()
                if (m === Move.Punch) playPunch()
                if (m === Move.Kick)  playKick()
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
