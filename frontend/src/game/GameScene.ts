/**
 * game/GameScene.ts — Phaser Scene for gameplay.
 *
 * ALL rendering is manual Canvas 2D in the scene's 'postrender' event handler.
 * update() is pure logic (camera scroll, gravity, event detection).
 * No Phaser display objects are used — just ctx.drawImage / ctx.fillRect etc.
 *
 * Render order per frame:
 *   Phaser preRender() → clears canvas to #0a0a0f
 *   Phaser renders display list (empty)
 *   scene 'postrender' fires → our _onPostRender() draws everything
 *   game  'postrender' fires → RetroGL composites to glCanvas
 */
import Phaser from 'phaser'
import {
  LEVEL_MAP, LEVEL_WIDTH, LEVEL_HEIGHT, Move, getEnemyPositions,
} from '../physics'
import type { LocalGameState }  from '../useLocalPhysics'
import type { GameBridge }      from './types'
import {
  playGemCollect, playHurt, playEnemyDefeat, playGameOver, playWin, stopMusic,
} from '../sound'

// ── Constants ─────────────────────────────────────────────────────────────────
const TILE       = 16
const COLS       = LEVEL_WIDTH
const ROWS       = LEVEL_HEIGHT
const VIEWPORT_W = 20
const VIEWPORT_H = 12
const CANVAS_W   = VIEWPORT_W * TILE   // 320
const CANVAS_H   = VIEWPORT_H * TILE   // 192
const SPR_W      = TILE * 2            // 32
const SPR_H      = TILE * 3            // 48
const ENEMY_COLS = 3
const ENEMY_ROWS = 4

// Frame indices within captain_actions sheet (3 cols × 2 rows)
const FRAME_PUNCH = 0
const FRAME_KICK  = 1
const FRAME_JUMP  = 2
const FRAME_HURT  = 3

// ── Tile drawing ──────────────────────────────────────────────────────────────
function drawTileToCtx(
  ctx: CanvasRenderingContext2D,
  tile: number, px: number, py: number, t = 0,
) {
  const s = TILE / 8
  switch (tile) {
    case 0: return
    case 1:
      ctx.fillStyle = '#1a2a4e'; ctx.fillRect(px, py, TILE, TILE)
      ctx.fillStyle = '#2a3d72'
      ctx.fillRect(px, py, TILE, s); ctx.fillRect(px, py, s, TILE)
      ctx.fillStyle = '#0d1a30'; ctx.fillRect(px, py + TILE - s, TILE, s)
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

// ── Scene ─────────────────────────────────────────────────────────────────────
export class GameScene extends Phaser.Scene {
  private bridge!: GameBridge

  // Manual camera scroll (tile-pixel units)
  private scrollX    = 0
  private scrollY    = 0
  // Manual screen shake
  private shakeX     = 0
  private shakeY     = 0
  private shakeTtl   = 0

  // State tracking for event detection
  private prevHealth   = 3
  private prevEnemies  = 0
  private prevScore    = 0
  private prevVelY     = 0

  // Auto-gravity counter
  private gravTickCount = 0

  // End-screen animation frame counter (0 = inactive)
  private endScreenFrame = 0

  // Portal visible after intro ends
  private portalVisible = false

  // Landing particles
  private landParticles: Array<{x:number;y:number;vx:number;vy:number;age:number}> = []

  // Snapshot captured in update(), used in postrender
  private _ls: LocalGameState | null = null
  private _t  = 0

  // ── Constructor ───────────────────────────────────────────────────────────────
  constructor(bridge: GameBridge) {
    super({ key: 'GameScene' })
    this.bridge = bridge
  }

  // ── preload ───────────────────────────────────────────────────────────────────
  preload() {
    this.load.image('bg', '/img/background_new.png')
  }

  // ── create ────────────────────────────────────────────────────────────────────
  create() {
    // Snap initial camera to player spawn (posY ≈ 14)
    this.scrollY = Math.max(0, Math.min(ROWS - VIEWPORT_H, 14 - VIEWPORT_H / 2)) * TILE

    // All drawing happens here — after Phaser's render pass clears the canvas
    this.events.on('postrender', this._onPostRender, this)

    // Seed state-change trackers from current bridge state
    const ls = this.bridge.getState()
    this.prevHealth  = ls.player.health
    this.prevEnemies = ls.enemiesDefeated
    this.prevScore   = ls.player.score
    this.prevVelY    = ls.player.velY
  }

  // ── update — logic only, NO canvas drawing ────────────────────────────────────
  update() {
    const ls = this.bridge.getState()

    // Frame counter (hitstop = freeze animation counter)
    if (this.bridge.hitstop.current > 0) {
      this.bridge.hitstop.current--
    } else {
      this.bridge.frame.current++

      // Auto-gravity: fire Idle tick every 7 frames while airborne
      if (ls.active && ls.player.velY !== 0 && this.bridge.canMove.current) {
        this.gravTickCount++
        if (this.gravTickCount >= 7) {
          this.gravTickCount = 0
          this.bridge.onAutoGrav()
        }
      } else {
        this.gravTickCount = 0
      }
    }

    // Smooth camera scroll
    const posX    = ls.player.posX
    const posY    = ls.player.posY
    const targetX = Math.max(0, Math.min(COLS - VIEWPORT_W, posX - VIEWPORT_W / 2)) * TILE
    const targetY = Math.max(0, Math.min(ROWS - VIEWPORT_H, posY - VIEWPORT_H / 2)) * TILE
    this.scrollX  += (targetX - this.scrollX) * 0.15
    this.scrollY  += (targetY - this.scrollY) * 0.15

    // Screen shake decay
    if (this.shakeTtl > 0) {
      this.shakeTtl--
      const decay = this.shakeTtl > 0 ? this.shakeTtl / 12 : 0
      this.shakeX = decay > 0 ? (Math.random() - 0.5) * 8 * decay : 0
      this.shakeY = decay > 0 ? (Math.random() - 0.5) * 5 * decay : 0
    }

    // Landing particle physics (spawn + advance — drawing is in postrender)
    this._updateLandingPhysics(ls)

    // State-change event detection (sounds, effects)
    this._detectEvents(ls)

    // Snapshot for postrender
    this._ls = ls
    this._t  = this.bridge.frame.current
  }

  // ── postrender handler — all Canvas 2D drawing ────────────────────────────────
  private _onPostRender() {
    const renderer = this.sys.game.renderer as Phaser.Renderer.Canvas.CanvasRenderer
    const ctx = renderer.currentContext
    if (!ctx || !this._ls) return
    this._renderFrame(ctx, this._ls, this._t)
  }

  // ── Event detection ──────────────────────────────────────────────────────────
  private _detectEvents(ls: LocalGameState) {
    const hp    = ls.player.health
    const score = ls.player.score
    const defs  = ls.enemiesDefeated

    if (hp < this.prevHealth) {
      this.bridge.effects.current.hitFlash  = 0.92
      this.bridge.hurtFrames.current        = 20
      this.shakeX = (Math.random() - 0.5) * 8
      this.shakeY = (Math.random() - 0.5) * 5
      this.shakeTtl = 12
      playHurt()
    }
    this.prevHealth = hp

    if (defs > this.prevEnemies) {
      this.bridge.effects.current.defFlash = 0.85
      this.bridge.hitstop.current = Math.max(this.bridge.hitstop.current, 8)
      playEnemyDefeat()
    }
    this.prevEnemies = defs

    if (score > this.prevScore && defs === this.prevEnemies) {
      playGemCollect()
    }
    this.prevScore = score

    if (!ls.active && this.endScreenFrame === 0) {
      this.endScreenFrame = 1
      this.bridge.effects.current.glitch = 1.0
      stopMusic()
      if (ls.won) playWin()
      else        playGameOver()
    }

    if (this.bridge.requestShake.current) {
      const { intensity, duration } = this.bridge.requestShake.current
      this.shakeX   = (Math.random() - 0.5) * intensity * CANVAS_W * 0.5
      this.shakeY   = (Math.random() - 0.5) * intensity * CANVAS_H * 0.5
      this.shakeTtl = Math.round(duration / 16.67)
      this.bridge.requestShake.current = null
    }
  }

  // ── Landing particle physics ──────────────────────────────────────────────────
  private _updateLandingPhysics(ls: LocalGameState) {
    const velY   = ls.player.velY
    const prevVY = this.prevVelY
    this.prevVelY = velY

    if (prevVY < 0 && velY === 0) {
      const speed = Math.abs(prevVY)
      // Store world-space coords; drawing converts to screen-space each frame
      const wx = ls.player.posX * TILE + TILE / 2
      const wy = ls.player.posY * TILE
      for (let d = 0; d < 10; d++) {
        const angle = Math.PI + (d / 9) * Math.PI
        this.landParticles.push({
          x: wx, y: wy,
          vx: Math.cos(angle) * (0.8 + Math.random() * speed * 0.6),
          vy: Math.sin(angle) * (0.3 + Math.random() * 0.6) - 0.5,
          age: 0,
        })
      }
      if (speed >= 3) {
        this.shakeX = 0; this.shakeY = 2 + speed * 0.3; this.shakeTtl = 5
      }
    }
    // Advance particle physics
    this.landParticles = this.landParticles.filter(p => p.age < 28)
    for (const p of this.landParticles) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.18; p.age++
    }
  }

  // ── Full render pass ──────────────────────────────────────────────────────────
  private _renderFrame(ctx: CanvasRenderingContext2D, ls: LocalGameState, t: number) {
    const ox = Math.round(this.scrollX) + Math.round(this.shakeX)
    const oy = Math.round(this.scrollY) + Math.round(this.shakeY)

    ctx.imageSmoothingEnabled = false

    // Background
    this._drawBg(ctx, ox, oy)

    // Tiles
    this._drawTiles(ctx, ls, t, ox, oy)

    // Portal (visible after intro)
    if (this.portalVisible) this._drawPortal(ctx, t, ox, oy)

    // Landing particles
    this._drawLandingParticles(ctx, ox, oy)

    // Captain
    this._drawCaptain(ctx, ls, t, ox, oy)

    // Enemies
    this._drawEnemies(ctx, ls, t, ox, oy)

    // Hit spark
    this._drawHitSpark(ctx, t, ox, oy)

    // Combo text (Canvas 2D, no Phaser Text object)
    this._drawComboText(ctx, ls, ox, oy)

    // Hurt frames countdown
    if (this.bridge.hurtFrames.current > 0) this.bridge.hurtFrames.current--

    // End-screen overlay
    if (this.endScreenFrame > 0) {
      this._drawEndScreen(ctx, ls)
      this.endScreenFrame++
    }
  }

  // ── Background ───────────────────────────────────────────────────────────────
  private _drawBg(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    if (!this.textures.exists('bg')) {
      ctx.fillStyle = '#06060f'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      return
    }
    const bgTex = this.textures.get('bg')
    const bgImg = bgTex.source[0].image as HTMLImageElement
    if (!bgImg?.complete || !bgImg.naturalWidth) {
      ctx.fillStyle = '#06060f'; ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      return
    }
    const camTX = ox / TILE  // camera x in tile units
    const camTY = oy / TILE
    ctx.drawImage(
      bgImg,
      (camTX / COLS) * bgImg.naturalWidth,  (camTY / ROWS) * bgImg.naturalHeight,
      (VIEWPORT_W / COLS) * bgImg.naturalWidth, (VIEWPORT_H / ROWS) * bgImg.naturalHeight,
      0, 0, CANVAS_W, CANVAS_H,
    )
  }

  // ── Tiles ────────────────────────────────────────────────────────────────────
  private _drawTiles(ctx: CanvasRenderingContext2D, ls: LocalGameState, t: number, ox: number, oy: number) {
    const x0 = Math.floor(ox / TILE)
    const y0 = Math.floor(oy / TILE)
    for (let y = y0; y <= y0 + VIEWPORT_H + 1; y++) {
      for (let x = x0; x <= x0 + VIEWPORT_W + 1; x++) {
        if (x < 0 || x >= COLS || y < 0 || y >= ROWS) continue
        const idx  = y * COLS + x
        const tile = ls.clearedTiles.has(idx) ? 0 : LEVEL_MAP[idx]
        drawTileToCtx(ctx, tile, x * TILE - ox, y * TILE - oy, t)
      }
    }
  }

  // ── Portal ───────────────────────────────────────────────────────────────────
  private _drawPortal(ctx: CanvasRenderingContext2D, t: number, ox: number, oy: number) {
    const px    = (COLS - 4) * TILE - ox
    const py    = 9 * TILE - oy
    const pulse = (Math.sin(t * 0.05) + 1) * 0.5
    ctx.strokeStyle = `rgba(153,51,255,${0.7 + pulse * 0.3})`
    ctx.lineWidth   = 3
    ctx.shadowColor = '#9933ff'
    ctx.shadowBlur  = 12 + pulse * 8
    ctx.beginPath()
    ctx.ellipse(px + TILE * 2, py + TILE, TILE * 2, TILE * 0.8, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = `rgba(153,51,255,${0.12 + pulse * 0.08})`
    ctx.beginPath()
    ctx.ellipse(px + TILE * 2, py + TILE, TILE * 2, TILE * 0.8, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur  = 0
    ctx.fillStyle   = '#cc88ff'
    ctx.font        = '5px monospace'
    ctx.textAlign   = 'center'
    ctx.fillText('EXIT', px + TILE * 2, py + TILE + 2)
    ctx.textAlign   = 'left'

    // Euphoria hovers above portal
    const bossCanvas = this.bridge.sprites.boss.current
    if (bossCanvas) {
      const BOSS_W = SPR_W * 2
      const BOSS_H = SPR_H * 2
      const bcw    = bossCanvas.width  / 3
      const bch    = bossCanvas.height / 4
      const bcol   = Math.floor(t / 14) % 3
      const hoverY = py - SPR_H * 3 - TILE + Math.sin(t * 0.03) * TILE * 0.6
      const bpulse = (Math.sin(t * 0.04) + 1) * 0.5
      ctx.shadowColor = '#9933ff'
      ctx.shadowBlur  = 12 + bpulse * 10
      ctx.globalAlpha = 0.9
      ctx.drawImage(bossCanvas, bcol * bcw, 0, bcw, bch,
        px + TILE - BOSS_W / 2, hoverY, BOSS_W, BOSS_H)
      ctx.globalAlpha = 1
      ctx.shadowBlur  = 0
    }
  }

  // ── Landing particles (draw) ──────────────────────────────────────────────────
  private _drawLandingParticles(ctx: CanvasRenderingContext2D, ox: number, oy: number) {
    for (const p of this.landParticles) {
      ctx.globalAlpha = Math.max(0, (1 - p.age / 28) * 0.85)
      ctx.fillStyle   = '#aaccff'
      ctx.fillRect(p.x - ox, p.y - oy, 2, 2)
    }
    ctx.globalAlpha = 1
  }

  // ── Captain ───────────────────────────────────────────────────────────────────
  private _drawCaptain(ctx: CanvasRenderingContext2D, ls: LocalGameState, t: number, ox: number, oy: number) {
    const lm      = this.bridge.lastMove.current
    const hurt    = this.bridge.hurtFrames.current > 0
    const velY    = ls.player.velY
    const facing  = this.bridge.facing.current
    const px      = ls.player.posX * TILE - ox
    const py      = ls.player.posY * TILE - oy
    const dx      = px - SPR_W / 2
    const dy      = py - SPR_H + TILE

    const useActions = hurt || velY !== 0 || lm === Move.Punch || lm === Move.Kick

    ctx.save()
    ctx.shadowColor = hurt ? '#ff4444' : '#4499ff'
    ctx.shadowBlur  = 8

    if (useActions) {
      const actCanvas = this.bridge.sprites.captainActions.current
      if (!actCanvas) { ctx.restore(); return }
      let frame = FRAME_JUMP
      if (hurt)                    frame = FRAME_HURT
      else if (velY !== 0)         frame = FRAME_JUMP
      else if (lm === Move.Punch)  frame = FRAME_PUNCH
      else if (lm === Move.Kick)   frame = FRAME_KICK
      const cw = Math.floor(actCanvas.width  / 3)
      const ch = Math.floor(actCanvas.height / 2)
      const sx = (frame % 3) * cw
      const sy = Math.floor(frame / 3) * ch
      if (facing === -1) {
        ctx.translate(dx + SPR_W, 0); ctx.scale(-1, 1)
        ctx.drawImage(actCanvas, sx, sy, cw, ch, 0, dy, SPR_W, SPR_H)
      } else {
        ctx.drawImage(actCanvas, sx, sy, cw, ch, dx, dy, SPR_W, SPR_H)
      }
    } else {
      const walkCanvas = this.bridge.sprites.captainWalk.current
      if (!walkCanvas) { ctx.restore(); return }
      const walkFrame = (lm === Move.Left || lm === Move.Right)
        ? Math.floor(t / 6) % 6
        : 0
      const cw = Math.floor(walkCanvas.width  / 3)
      const ch = Math.floor(walkCanvas.height / 4)
      const sx = (walkFrame % 3) * cw
      const sy = Math.floor(walkFrame / 3) * ch
      if (facing === -1) {
        ctx.translate(dx + SPR_W, 0); ctx.scale(-1, 1)
        ctx.drawImage(walkCanvas, sx, sy, cw, ch, 0, dy, SPR_W, SPR_H)
      } else {
        ctx.drawImage(walkCanvas, sx, sy, cw, ch, dx, dy, SPR_W, SPR_H)
      }
    }
    ctx.shadowBlur = 0; ctx.restore()
  }

  // ── Enemies ───────────────────────────────────────────────────────────────────
  private _drawEnemies(ctx: CanvasRenderingContext2D, ls: LocalGameState, t: number, ox: number, oy: number) {
    const enemies = getEnemyPositions(ls.enemiesDefeated, ls.tick, this.bridge.level)
    enemies.forEach((e, i) => {
      if (!e.alive) return
      const esx = e.posX * TILE - ox
      const esy = e.posY * TILE - oy
      if (esx < -TILE * 2 || esx > CANVAS_W + TILE) return
      if (esy < -TILE * 2 || esy > CANVAS_H + TILE) return

      const eCanvas = (i % 2 === 1 ? this.bridge.sprites.enemyDemon : this.bridge.sprites.enemyTroll).current
      if (!eCanvas) return
      const cw       = Math.floor(eCanvas.width  / ENEMY_COLS)
      const ch       = Math.floor(eCanvas.height / ENEMY_ROWS)
      const adjacent = Math.abs(e.posX - ls.player.posX) <= 1 && e.posY === ls.player.posY
      const row      = adjacent ? 1 : 0
      const col      = Math.floor(t / 8) % ENEMY_COLS
      const sx       = col * cw
      const sy       = row * ch
      const dx       = esx - SPR_W / 2
      const dy       = esy - SPR_H + TILE
      ctx.save()
      ctx.shadowColor = i % 2 === 1 ? '#ff2200' : '#ff44aa'
      ctx.shadowBlur  = 6
      if (e.facing === -1) {
        ctx.translate(dx + SPR_W, 0); ctx.scale(-1, 1)
        ctx.drawImage(eCanvas, sx, sy, cw, ch, 0, dy, SPR_W, SPR_H)
      } else {
        ctx.drawImage(eCanvas, sx, sy, cw, ch, dx, dy, SPR_W, SPR_H)
      }
      ctx.shadowBlur = 0; ctx.restore()
    })
  }

  // ── Hit spark ─────────────────────────────────────────────────────────────────
  private _drawHitSpark(ctx: CanvasRenderingContext2D, _t: number, ox: number, oy: number) {
    const spark = this.bridge.hitSpark.current
    if (!spark || this.bridge.hitstop.current <= 0) return
    const sx    = spark.tx * TILE - ox + TILE / 2
    const sy    = spark.ty * TILE - oy
    const fade  = this.bridge.hitstop.current / 9
    const color = spark.combo >= 3 ? [255, 60, 60]
                : spark.combo >= 2 ? [255, 140, 30]
                :                    [255, 230, 60]
    ctx.save()
    ctx.shadowColor = `rgb(${color.join(',')})`
    ctx.shadowBlur  = spark.combo >= 3 ? 10 : 6
    for (let r = 0; r < 8; r++) {
      const angle = (r / 8) * Math.PI * 2
      const len   = TILE * (spark.combo >= 3 ? 1.0 : 0.7)
      ctx.strokeStyle = `rgba(${color.join(',')},${fade})`
      ctx.lineWidth   = spark.combo >= 3 ? 2 : 1.5
      ctx.beginPath()
      ctx.moveTo(sx, sy)
      ctx.lineTo(sx + Math.cos(angle) * len, sy + Math.sin(angle) * len)
      ctx.stroke()
    }
    ctx.restore()
  }

  // ── Combo text ────────────────────────────────────────────────────────────────
  private _drawComboText(ctx: CanvasRenderingContext2D, ls: LocalGameState, ox: number, oy: number) {
    const combo = this.bridge.combo.current
    if (combo.displayFrames <= 0 || combo.count < 2) return
    combo.displayFrames--
    const alpha = Math.min(1, combo.displayFrames / 10)
    const color = combo.count >= 3 ? '#ff3c3c' : '#ffa01e'
    const label = combo.count >= 3 ? `${combo.count}x FINISHER!` : `${combo.count}x COMBO`
    const cx    = ls.player.posX * TILE - ox + TILE / 2
    const cy    = ls.player.posY * TILE - oy - 6
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.font        = `bold ${combo.count >= 3 ? 9 : 7}px monospace`
    ctx.fillStyle   = color
    ctx.shadowColor = color
    ctx.shadowBlur  = 4
    ctx.textAlign   = 'center'
    ctx.fillText(label, cx, cy)
    ctx.shadowBlur = 0; ctx.restore()
  }

  // ── End-screen overlay ────────────────────────────────────────────────────────
  private _drawEndScreen(ctx: CanvasRenderingContext2D, ls: LocalGameState) {
    const f = this.endScreenFrame
    if (ls.won) {
      ctx.fillStyle = `rgba(20,14,0,${Math.min(f / 40, 0.6)})`
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      const rayLen = Math.min(f / 60, 1) * (CANVAS_W * 0.9)
      ctx.save(); ctx.translate(CANVAS_W / 2, CANVAS_H / 2)
      for (let i = 0; i < 12; i++) {
        const angle = (i / 12) * Math.PI * 2 + f * 0.01
        ctx.strokeStyle = `rgba(255,210,50,${Math.min(f / 30, 1) * 0.32})`
        ctx.lineWidth = 3
        ctx.beginPath(); ctx.moveTo(0, 0)
        ctx.lineTo(Math.cos(angle) * rayLen, Math.sin(angle) * rayLen)
        ctx.stroke()
      }
      ctx.restore()
      if (f >= 20) {
        const hue = (f * 4) % 360
        ctx.globalAlpha = Math.min((f - 20) / 20, 1)
        ctx.font = 'bold 16px monospace'; ctx.textAlign = 'center'
        ctx.shadowColor = `hsl(${hue},100%,60%)`; ctx.shadowBlur = 8
        ctx.fillStyle   = `hsl(${hue},100%,70%)`
        ctx.fillText('LEVEL CLEAR!', CANVAS_W / 2, CANVAS_H / 2 - 10)
        ctx.shadowBlur = 0; ctx.globalAlpha = 1
      }
      if (f >= 55) {
        ctx.globalAlpha = Math.min((f - 55) / 15, 1)
        ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#ffd230'
        ctx.fillText(`SCORE  ${ls.player.score.toString().padStart(6, '0')}`, CANVAS_W / 2, CANVAS_H / 2 + 8)
        ctx.globalAlpha = 1
      }
    } else {
      ctx.fillStyle = `rgba(140,0,0,${Math.min(f / 22, 0.72)})`
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
      if (f >= 12) {
        const glitchX = f < 30 ? (Math.random() - 0.5) * 6 : 0
        ctx.globalAlpha = Math.min((f - 12) / 15, 1)
        ctx.font = 'bold 15px monospace'; ctx.textAlign = 'center'
        ctx.shadowColor = '#ff0044'; ctx.shadowBlur = 10; ctx.fillStyle = '#ff4466'
        ctx.fillText('GAME OVER', CANVAS_W / 2 + glitchX, CANVAS_H / 2 - 10)
        ctx.shadowBlur = 0; ctx.globalAlpha = 1
      }
      if (f >= 40) {
        ctx.globalAlpha = Math.min((f - 40) / 15, 1)
        ctx.font = '9px monospace'; ctx.textAlign = 'center'; ctx.fillStyle = '#ff8899'
        ctx.fillText(`SCORE  ${ls.player.score.toString().padStart(6, '0')}`, CANVAS_W / 2, CANVAS_H / 2 + 8)
        ctx.globalAlpha = 1
      }
    }
    ctx.textAlign = 'left'
  }

  // ── Called by IntroScene when intro finishes ──────────────────────────────────
  showPortal() {
    this.portalVisible = true
  }
}
