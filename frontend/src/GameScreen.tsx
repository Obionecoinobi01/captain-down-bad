import { useCallback, useEffect, useRef } from 'react'
import Phaser from 'phaser'
import { initRetroGL, DEFAULT_RETRO, type RetroGL } from './effects'
import {
  startMusic, stopMusic,
  playJump, playPunch, playKick, playLand,
  playGemCollect, playHurt, playEnemyDefeat,
  playWin, playGameOver, playPortalOpen,
  playComboHit,
} from './sound'
import { useRun, useGemEventFetcher } from './useGameState'
import { useSessionKey } from './useSessionKey'
import { useLocalPhysics } from './useLocalPhysics'
import { useMoveQueue } from './useMoveQueue'
import { loadSpriteSheet } from './removeBackground'
import { LEVEL_WIDTH, Move, getEnemyPositions, getLevel } from './physics'
import type { Move as MoveType } from './physics'
import { formatUnits } from 'viem'
import { publicClient, CONTRACT_ADDRESS } from './wagmi'
import { CDB_ABI } from './abi'
import { MOVE_LABELS } from './useSubmitMove'
import { IntroScene } from './game/IntroScene'
import { GameScene } from './game/GameScene'
import type { GameBridge } from './game/types'

interface Props {
  runId:   bigint
  levelId?: number
  onBack:  () => void
}

// ── Canvas config ──────────────────────────────────────────────────────────────
const CANVAS_W = 20 * 16   // 320
const CANVAS_H = 12 * 16   // 192

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
export function GameScreen({ runId, levelId = 0, onBack }: Props) {
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
    run?.playerState,
    levelId,
  )

  // ── Move queue (batches moves, submits to chain) ──────────────────────────────
  const handleBatchConfirmed = useCallback(() => {
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

  // Stable refs so Phaser/keydown can call applyMove/enqueue without stale closures
  const applyMoveRef = useRef(applyMove)
  applyMoveRef.current = applyMove
  const enqueueRef = useRef(enqueue)
  enqueueRef.current = enqueue

  // ── Canvas refs ───────────────────────────────────────────────────────────────
  const canvasRef   = useRef<HTMLCanvasElement>(null)   // Canvas 2D — hidden, Phaser renders here
  const glCanvasRef = useRef<HTMLCanvasElement>(null)   // WebGL — visible display
  const glStateRef  = useRef<RetroGL | null>(null)
  const frameRef     = useRef(0)
  const localRef     = useRef(localState)
  localRef.current   = localState
  const prevLocalRef = useRef(localState)

  // ── Sprite refs (loaded async, passed to Phaser via bridge) ───────────────────
  const spriteRef     = useRef<HTMLCanvasElement | null>(null)   // captain walk
  const actionsRef    = useRef<HTMLCanvasElement | null>(null)   // captain actions
  const enemySheetRef = useRef<HTMLCanvasElement | null>(null)   // troll
  const demonSheetRef = useRef<HTMLCanvasElement | null>(null)   // demon
  const bossSheetRef  = useRef<HTMLCanvasElement | null>(null)   // boss

  // ── Visual effect refs (read by Phaser's postrender, written by keydown) ──────
  const effectsRef      = useRef({ hitFlash: 0, defFlash: 0, glitch: 0 })
  const requestShakeRef = useRef<{ intensity: number; duration: number } | null>(null)
  const hitstopRef      = useRef(0)
  const hitSparkRef     = useRef<{ tx: number; ty: number; combo: number } | null>(null)
  const comboRef        = useRef({ count: 0, resetAt: 0, displayFrames: 0 })
  const hurtFramesRef   = useRef(0)
  const lastMoveRef     = useRef<MoveType | null>(null)
  const facingRef       = useRef(1)   // 1 = right, -1 = left

  // ── Phaser instance + intro gate ──────────────────────────────────────────────
  const phaserRef      = useRef<Phaser.Game | null>(null)
  const introActiveRef = useRef(true)   // blocks input until IntroScene calls onIntroEnd

  // Init WebGL post-processing
  useEffect(() => {
    const canvas = glCanvasRef.current
    if (!canvas) return
    glStateRef.current = initRetroGL(canvas)
    return () => { glStateRef.current?.dispose(); glStateRef.current = null }
  }, [])

  // Game music — level 1 gets its own Dm track
  useEffect(() => {
    startMusic(levelId > 0 ? 'level2' : 'game')
    return () => stopMusic()
  }, [levelId])

  // Load sprite sheets (background removal) — results stored in refs for bridge
  useEffect(() => {
    loadSpriteSheet('/img/sprites/captain_1.png').then(c        => { spriteRef.current     = c })
    loadSpriteSheet('/img/sprites/captain_actions.png').then(c  => { actionsRef.current    = c })
    loadSpriteSheet('/img/sprites/enemy_troll_new.png').then(c  => { enemySheetRef.current = c })
    loadSpriteSheet('/img/sprites/enemy_demon_new.png').then(c  => { demonSheetRef.current = c })
    loadSpriteSheet('/img/sprites/boss_dancer.png').then(c      => { bossSheetRef.current  = c })
  }, [])

  // ── SFX: fire on local state transitions ──────────────────────────────────────
  useEffect(() => {
    const prev = prevLocalRef.current
    const curr = localState

    // Gem collected
    if (curr.clearedTiles.size > prev.clearedTiles.size) playGemCollect()

    // Enemy defeated
    if (curr.enemiesDefeated > prev.enemiesDefeated) playEnemyDefeat()

    // Player hurt (health dropped)
    if (curr.player.health < prev.player.health) playHurt()

    // Landing from a jump: velY was ≤ -2 (falling) → 0 (landed)
    // Threshold -2 avoids the normal ground-idle tick where velY briefly hits -1
    if (prev.player.velY <= -2 && curr.player.velY === 0) playLand()

    // Run ended
    if (prev.active && !curr.active) {
      stopMusic()
      if (curr.won) { playWin(); playPortalOpen() }
      else            playGameOver()
    }

    prevLocalRef.current = curr
  }, [localState])

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
      if (!canMoveRef.current)   return
      if (introActiveRef.current) return
      const move = KEY_MOVE[e.key]
      if (move === undefined) return
      e.preventDefault()
      lastMoveRef.current = move
      if (move === Move.Left)  facingRef.current = -1
      if (move === Move.Right) facingRef.current =  1
      if (move === Move.Jump)  playJump()
      if (move === Move.Punch) playPunch()
      if (move === Move.Kick)  playKick()

      // Hit detection for hitstop + spark
      if (move === Move.Punch || move === Move.Kick) {
        const curLs    = localRef.current
        const enemies  = getEnemyPositions(curLs.enemiesDefeated, curLs.tick, getLevel(levelId))
        const hitEnemy = enemies.find(en =>
          en.alive &&
          Math.abs(en.posX - curLs.player.posX) <= 1 &&
          en.posY === curLs.player.posY
        )
        if (hitEnemy) {
          const combo = comboRef.current
          const now   = frameRef.current
          if (move === Move.Punch) {
            if (now <= combo.resetAt && combo.count > 0) combo.count++
            else combo.count = 1
            combo.resetAt = now + 50
          } else {
            combo.count = 0; combo.resetAt = 0
          }
          combo.displayFrames = 60
          const isFinisher  = combo.count >= 3
          hitstopRef.current  = isFinisher ? 9
                              : move === Move.Kick ? 6
                              : 3 + Math.min(combo.count, 3)
          hitSparkRef.current = { tx: hitEnemy.posX, ty: hitEnemy.posY, combo: combo.count }
          playComboHit(combo.count)
          if (isFinisher) {
            requestShakeRef.current = { intensity: 0.009, duration: 180 }
          }
        }
      }
      applyMoveRef.current(move)
      enqueueRef.current(move)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyMove, enqueue])

  // ── Phaser game (replaces RAF draw loop) ──────────────────────────────────────
  useEffect(() => {
    const canvas   = canvasRef.current
    const glCanvas = glCanvasRef.current
    if (!canvas || !glCanvas) return

    const bridge: GameBridge = {
      getState:  () => localRef.current,
      level:     getLevel(levelId),
      lastMove:  lastMoveRef,
      facing:    facingRef,
      canMove:   canMoveRef,
      frame:     frameRef,
      hitstop:   hitstopRef,
      hitSpark:  hitSparkRef,
      combo:     comboRef,
      hurtFrames: hurtFramesRef,
      effects:   effectsRef,
      requestShake: requestShakeRef,
      sprites: {
        captainWalk:    spriteRef,
        captainActions: actionsRef,
        enemyTroll:     enemySheetRef,
        enemyDemon:     demonSheetRef,
        boss:           bossSheetRef,
      },
      onAutoGrav: () => {
        applyMoveRef.current(Move.Idle)
        enqueueRef.current(Move.Idle)
      },
      onIntroEnd: () => {
        introActiveRef.current = false
      },
    }

    const game = new Phaser.Game({
      type:            Phaser.CANVAS,
      canvas,
      width:           CANVAS_W,
      height:          CANVAS_H,
      backgroundColor: '#0a0a0f',
      scene:           [new IntroScene(bridge), new GameScene(bridge)],
      render:          { pixelArt: true, antialias: false },
      audio:           { noAudio: true },
    })

    // RetroGL post-processing: fires once per Phaser render tick
    game.events.on('postrender', () => {
      const retro = glStateRef.current
      if (!retro) return
      const e = effectsRef.current
      retro.render(canvas, {
        ...DEFAULT_RETRO,
        time:     performance.now() / 1000,
        hitFlash: e.hitFlash,
        defFlash: e.defFlash,
        glitch:   e.glitch,
      })
      e.hitFlash = Math.max(0, e.hitFlash - 0.10)
      e.defFlash = Math.max(0, e.defFlash - 0.09)
      e.glitch   = Math.max(0, e.glitch   - 0.006)
    })

    phaserRef.current = game
    return () => {
      game.destroy(true)
      phaserRef.current = null
    }
  }, [])   // run once on mount; refs are stable

  // ── HUD values ────────────────────────────────────────────────────────────────
  const hp       = localState.player.health
  const hearts   = '♥'.repeat(hp) + '♡'.repeat(Math.max(0, 3 - hp))
  const score    = localState.player.score.toString().padStart(6, '0')
  const tick     = localState.tick.toString()
  const runEnded = !localState.active

  const payoutDisplay = (() => {
    const bet = run?.bet ?? 0n
    if (bet === 0n || !localState.won) return null
    const finalScore    = BigInt(localState.player.score)
    const multiplierBps = 10000n + finalScore
    const gross         = bet * multiplierBps / 10000n
    const fee           = gross * 100n / 10000n
    return formatUnits(gross - fee, 6)
  })()

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

  const skBusy = skStatus === 'authorizing' || skStatus === 'confirming'
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
        {/* Canvas 2D — hidden, Phaser renders here as source texture for WebGL */}
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
        <div className={`game-over ${localState.won ? 'game-over--win' : 'game-over--lose'}`}>
          <div className="game-over-title">
            {localState.won ? '✦ LEVEL CLEAR ✦' : 'GAME OVER'}
          </div>
          {payoutDisplay && (
            <div className="game-over-payout">+{payoutDisplay} USDC</div>
          )}
          <div className="game-over-score">FINAL SCORE: {score}</div>
          {localState.won && (
            <div className="game-over-sub">payout sent to your wallet</div>
          )}
          <button
            className={localState.won ? 'btn-win' : 'btn-back'}
            onClick={onBack}
          >
            {localState.won ? '→ PLAY AGAIN' : '← PLAY AGAIN'}
          </button>
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
