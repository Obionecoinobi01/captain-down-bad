/**
 * game/IntroScene.ts — Phaser Scene for the 700-frame intro cutscene.
 *
 * Euphoria flies L→R, drops enemies onto their patrol rows,
 * Captain falls from sky, dialogue bubble types out.
 * On completion: calls bridge.onIntroEnd() then starts GameScene.
 *
 * IMPORTANT: all Canvas 2D drawing must happen in the scene's 'postrender'
 * event (not in update()), because Phaser clears the canvas AFTER update()
 * runs during its own render pass. Same pattern as GameScene.
 */
import Phaser from 'phaser'
import { LEVEL_MAP, LEVEL_WIDTH, LEVEL_HEIGHT } from '../physics'
import type { GameBridge } from './types'

// ── Constants (must match GameScene) ─────────────────────────────────────────
const TILE       = 16
const COLS       = LEVEL_WIDTH    // 32
const ROWS       = LEVEL_HEIGHT   // 16
const VIEWPORT_W = 20
const VIEWPORT_H = 12
const CANVAS_W   = VIEWPORT_W * TILE  // 320
const CANVAS_H   = VIEWPORT_H * TILE  // 192
const SPR_W      = TILE * 2           // 32
const SPR_H      = TILE * 3           // 48
const ENEMY_COLS = 3
const ENEMY_ROWS = 4

// ── Tile drawing (mirrors GameScene.drawTileToCtx) ────────────────────────────
function drawTileToCtx(
  ctx: CanvasRenderingContext2D,
  tile: number,
  px: number,
  py: number,
  t = 0,
) {
  const s = TILE / 8  // = 2
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

// ── Types for intro-specific state ───────────────────────────────────────────
interface EnemyDrop {
  x: number; y: number; targetY: number; vy: number; age: number; sheet: 0 | 1
}
interface Particle {
  x: number; y: number; vx: number; vy: number; age: number
}
interface GemSparkle {
  x: number; y: number; age: number
}

// ── Scene ─────────────────────────────────────────────────────────────────────
export class IntroScene extends Phaser.Scene {
  private bridge!: GameBridge

  private introFrame     = 0
  private gemSparkles:   GemSparkle[] = []
  private dustParticles: Particle[]   = []
  private enemyDrops:    EnemyDrop[]  = []

  // Snapshot for postrender (Euphoria's screen position this frame)
  private _eupWX   = 0
  private _bAlpha  = 1

  constructor(bridge: GameBridge) {
    super({ key: 'IntroScene' })
    this.bridge = bridge
  }

  // ── preload ──────────────────────────────────────────────────────────────────
  preload() {
    this.load.image('bg', '/img/background_new.png')
  }

  // ── create ───────────────────────────────────────────────────────────────────
  create() {
    // All drawing happens in postrender — AFTER Phaser clears the canvas.
    this.events.on('postrender', this._onPostRender, this)
  }

  // ── update — state/physics only, NO canvas drawing ───────────────────────────
  update() {
    this.introFrame++
    this.bridge.frame.current++

    const f  = this.introFrame
    const ls = this.bridge.getState()

    // Camera pan amount (pure calculation, used in postrender)
    const CAM_MAX = (COLS - VIEWPORT_W) * TILE
    let camX = 0
    if (f >= 20 && f < 280) {
      camX = Math.min(CAM_MAX, ((f - 20) / 260) * CAM_MAX)
    } else if (f >= 280 && f < 360) {
      camX = CAM_MAX
    } else if (f >= 360 && f < 480) {
      const p     = (f - 360) / 120
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
      camX = CAM_MAX * (1 - eased)
    }
    // Store world-space Euphoria x for postrender drawing
    const flyT      = Math.min(1, (f - 20) / 260)
    this._eupWX     = (1 + flyT * (COLS - 7)) * TILE
    this._bAlpha    = f > 360 ? Math.max(0, 1 - (f - 360) / 60) : 1
    void camX  // used directly in postrender via introFrame

    // Spawn gem sparkle trail (Euphoria drops gems while flying)
    if (f >= 20 && f < 300 && f % 40 === 20) {
      const eupY = 3 * TILE + Math.sin(f * 0.05) * TILE * 0.5
      this.gemSparkles.push({ x: this._eupWX + TILE, y: eupY + TILE * 2.5, age: 0 })
    }

    // Spawn enemy drops from Euphoria
    if (f === 124 && this.enemyDrops.length === 0) {
      const eupY = 3 * TILE + Math.sin(f * 0.05) * TILE * 0.5
      this.enemyDrops.push({
        x: this._eupWX, y: eupY + TILE * 2, targetY: 8 * TILE, vy: 0, age: 0, sheet: 0,
      })
    }
    if (f === 166 && this.enemyDrops.length < 2) {
      const eupY = 3 * TILE + Math.sin(f * 0.05) * TILE * 0.5
      this.enemyDrops.push({
        x: this._eupWX, y: eupY + TILE * 2, targetY: 14 * TILE, vy: 0, age: 0, sheet: 1,
      })
    }

    // Advance enemy drop physics
    for (const drop of this.enemyDrops) {
      drop.age++
      if (drop.y < drop.targetY) {
        drop.vy  += 0.5
        drop.y   += drop.vy
        if (drop.y >= drop.targetY) { drop.y = drop.targetY; drop.vy = 0 }
      }
    }

    // Advance gem sparkles
    this.gemSparkles = this.gemSparkles.filter(sp => sp.age < 50)
    for (const sp of this.gemSparkles) sp.age++

    // Spawn + advance dust particles (captain impact at f=510)
    if (f === 510) {
      const cLandX = 2 * TILE
      const cLandY = (ls.player.posY - 1) * TILE   // just above ground row
      for (let d = 0; d < 14; d++) {
        const angle = (d / 14) * Math.PI * 2
        this.dustParticles.push({
          x: cLandX + TILE / 2, y: cLandY,
          vx: Math.cos(angle) * (0.8 + Math.random() * 1.5),
          vy: Math.sin(angle) * (0.8 + Math.random() * 1.5) - 1.5,
          age: 0,
        })
      }
    }
    for (const p of this.dustParticles) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.25; p.age++
    }

    // End intro → switch to GameScene
    if (f >= 700) {
      this.bridge.onIntroEnd()
      this.scene.start('GameScene', { bridge: this.bridge })
    }
  }

  // ── postrender — all Canvas 2D drawing ───────────────────────────────────────
  private _onPostRender() {
    const renderer = this.sys.game.renderer as Phaser.Renderer.Canvas.CanvasRenderer
    const ctx = renderer.currentContext
    if (!ctx) return

    const f  = this.introFrame
    const t  = this.bridge.frame.current
    const ls = this.bridge.getState()

    ctx.imageSmoothingEnabled = false

    // ── Camera offset ────────────────────────────────────────────────────────
    const CAM_MAX = (COLS - VIEWPORT_W) * TILE
    let camX = 0
    if (f >= 20 && f < 280) {
      camX = Math.min(CAM_MAX, ((f - 20) / 260) * CAM_MAX)
    } else if (f >= 280 && f < 360) {
      camX = CAM_MAX
    } else if (f >= 360 && f < 480) {
      const p     = (f - 360) / 120
      const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2
      camX = CAM_MAX * (1 - eased)
    }
    const ox = -camX

    // ── Background ────────────────────────────────────────────────────────────
    const bgTex = this.textures.exists('bg') ? this.textures.get('bg') : null
    const bgImg = bgTex ? bgTex.source[0].image as HTMLImageElement : null
    if (bgImg?.complete && bgImg.naturalWidth > 0) {
      ctx.drawImage(
        bgImg,
        (camX / (COLS * TILE)) * bgImg.naturalWidth, 0,
        (CANVAS_W / (COLS * TILE)) * bgImg.naturalWidth, bgImg.naturalHeight,
        0, 0, CANVAS_W, CANVAS_H,
      )
    } else {
      ctx.fillStyle = '#06060f'
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    }

    // ── Level tiles ───────────────────────────────────────────────────────────
    const tx0 = Math.floor(camX / TILE)
    for (let iy = 0; iy <= VIEWPORT_H + 1; iy++) {
      for (let ix = tx0; ix <= tx0 + VIEWPORT_W + 1; ix++) {
        if (ix < 0 || ix >= COLS || iy < 0 || iy >= ROWS) continue
        const tile = ls.clearedTiles.has(iy * LEVEL_WIDTH + ix)
          ? 0
          : LEVEL_MAP[iy * LEVEL_WIDTH + ix]
        drawTileToCtx(ctx, tile, ix * TILE + ox, iy * TILE, t)
      }
    }

    // ── Portal materialises at f=240 ──────────────────────────────────────────
    if (f >= 240) {
      const pAlpha = Math.min(1, (f - 240) / 80)
      this._drawPortal(ctx, (COLS - 4) * TILE + ox, 9 * TILE, t, pAlpha)
    }

    // ── Euphoria flies L→R (f 20–420) ────────────────────────────────────────
    const bossCanvas = this.bridge.sprites.boss.current
    if (bossCanvas && f >= 20 && f < 420) {
      const eupSX = this._eupWX + ox
      const eupY  = 3 * TILE + Math.sin(f * 0.05) * TILE * 0.5
      const BOSS_W = SPR_W * 3
      const BOSS_H = SPR_H * 3
      const bcw    = bossCanvas.width  / 3
      const bch    = bossCanvas.height / 4
      const bcol   = Math.floor(t / 10) % 3
      const pulse  = (Math.sin(t * 0.1) + 1) * 0.5
      ctx.globalAlpha = this._bAlpha
      ctx.shadowColor = '#9933ff'
      ctx.shadowBlur  = 12 + pulse * 10
      ctx.drawImage(bossCanvas, bcol * bcw, 1 * bch, bcw, bch,
        eupSX - BOSS_W / 2, eupY, BOSS_W, BOSS_H)
      ctx.shadowBlur  = 0
      ctx.globalAlpha = 1
    }

    // ── Gem sparkles ──────────────────────────────────────────────────────────
    for (const sp of this.gemSparkles) {
      ctx.globalAlpha = Math.max(0, 1 - sp.age / 50)
      ctx.fillStyle   = '#00ffcc'
      ctx.shadowColor = '#00ffcc'
      ctx.shadowBlur  = 6
      ctx.fillRect(sp.x + ox - 2, sp.y + sp.age * 0.4, 4, 4)
      ctx.shadowBlur  = 0
      ctx.globalAlpha = 1
    }

    // ── Enemy drops ───────────────────────────────────────────────────────────
    for (const drop of this.enemyDrops) {
      const landed  = drop.y >= drop.targetY
      const eCanvas = drop.sheet === 1
        ? this.bridge.sprites.enemyDemon.current
        : this.bridge.sprites.enemyTroll.current
      if (eCanvas) {
        const cw  = eCanvas.width  / ENEMY_COLS
        const ch  = eCanvas.height / ENEMY_ROWS
        const col = landed ? Math.floor(t / 8) % ENEMY_COLS : 0
        ctx.shadowColor = drop.sheet === 1 ? '#ff2200' : '#ff44aa'
        ctx.shadowBlur  = 6
        ctx.drawImage(eCanvas, col * cw, 0, cw, ch,
          drop.x + ox - SPR_W / 2, drop.y - SPR_H + TILE, SPR_W, SPR_H)
        ctx.shadowBlur = 0
        // Impact ring on landing
        if (landed && drop.age < 10) {
          ctx.strokeStyle = `rgba(255,68,170,0.7)`
          ctx.lineWidth   = 2
          ctx.beginPath()
          ctx.arc(drop.x + ox, drop.targetY, TILE * 1.5 * (drop.age / 10), 0, Math.PI * 2)
          ctx.stroke()
        }
      }
    }

    // ── Captain falls from sky at (2, ~14) — frames 480–510 ──────────────────
    const cLandX = 2 * TILE
    const cLandY = 14 * TILE
    if (f >= 480 && f < 510) {
      const sp = (f - 480) / 30
      const sy = -TILE * 2 + (cLandY + TILE * 2) * sp
      ctx.strokeStyle = '#44aaff'
      ctx.lineWidth   = 3
      ctx.shadowColor = '#44aaff'
      ctx.shadowBlur  = 14
      ctx.beginPath()
      ctx.moveTo(cLandX + TILE / 2, sy - TILE * 3)
      ctx.lineTo(cLandX + TILE / 2, sy)
      ctx.stroke()
      ctx.shadowBlur = 0
    }

    if (f >= 510) {
      // Dust particles
      for (const p of this.dustParticles) {
        if (p.age < 35) {
          ctx.globalAlpha = Math.max(0, 1 - p.age / 35)
          ctx.fillStyle   = '#aaccff'
          ctx.fillRect(p.x, p.y, 3, 3)
          ctx.globalAlpha = 1
        }
      }

      // Impact ring (f 510–540)
      if (f < 540) {
        const rp = (f - 510) / 30
        ctx.strokeStyle = `rgba(100,180,255,${(1 - rp) * 0.9})`
        ctx.lineWidth   = 2
        ctx.beginPath()
        ctx.arc(cLandX + TILE / 2, cLandY, rp * TILE * 4, 0, Math.PI * 2)
        ctx.stroke()
      }

      // Captain standing idle
      const captCanvas = this.bridge.sprites.captainWalk.current
      if (captCanvas) {
        ctx.shadowColor = '#4499ff'
        ctx.shadowBlur  = 8
        this._drawCaptainIdle(ctx, captCanvas, cLandX, cLandY)
        ctx.shadowBlur = 0
      }

      // Power-down ring (f 540–600)
      if (f >= 540 && f < 600) {
        const rp = (f - 540) / 60
        ctx.strokeStyle = `rgba(68,153,255,${(1 - rp) * 0.7})`
        ctx.lineWidth   = Math.max(0.5, 2 - rp * 2)
        ctx.shadowColor = '#4499ff'
        ctx.shadowBlur  = 8
        ctx.beginPath()
        ctx.arc(cLandX + TILE / 2, cLandY, TILE + rp * TILE * 4, 0, Math.PI * 2)
        ctx.stroke()
        ctx.shadowBlur = 0
      }

      // Dialogue bubble (f 600–700)
      if (f >= 600) {
        this._drawDialogue(ctx, cLandX, cLandY, f)
      }
    }

    // ── Fade in from black (f 0–20) ───────────────────────────────────────────
    if (f <= 20) {
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0, 1 - f / 20)})`
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H)
    }
  }

  // ── Portal ────────────────────────────────────────────────────────────────
  private _drawPortal(
    ctx: CanvasRenderingContext2D,
    x: number, y: number,
    t: number, alpha: number,
  ) {
    const pulse = (Math.sin(t * 0.05) + 1) * 0.5
    ctx.globalAlpha = alpha
    ctx.strokeStyle = `rgba(153,51,255,${0.7 + pulse * 0.3})`
    ctx.lineWidth   = 3
    ctx.shadowColor = '#9933ff'
    ctx.shadowBlur  = 12 + pulse * 8
    ctx.beginPath()
    ctx.ellipse(x + TILE * 2, y + TILE, TILE * 2, TILE * 0.8, 0, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = `rgba(153,51,255,${0.12 + pulse * 0.08})`
    ctx.beginPath()
    ctx.ellipse(x + TILE * 2, y + TILE, TILE * 2, TILE * 0.8, 0, 0, Math.PI * 2)
    ctx.fill()
    ctx.shadowBlur  = 0
    ctx.fillStyle   = '#cc88ff'
    ctx.font        = '5px monospace'
    ctx.textAlign   = 'center'
    ctx.fillText('EXIT', x + TILE * 2, y + TILE + 2)
    ctx.textAlign   = 'left'
    ctx.globalAlpha = 1
  }

  // ── Captain idle (first walk frame) ──────────────────────────────────────
  private _drawCaptainIdle(
    ctx: CanvasRenderingContext2D,
    sheet: HTMLCanvasElement,
    px: number,
    py: number,
  ) {
    const cellW = Math.floor(sheet.width  / 3)
    const cellH = Math.floor(sheet.height / 4)
    const dx    = px - TILE / 2
    const dy    = py - SPR_H + TILE
    ctx.drawImage(sheet, 0, 0, cellW, cellH, dx, dy, SPR_W, SPR_H)
  }

  // ── Dialogue bubble with typewriter ───────────────────────────────────────
  private _drawDialogue(
    ctx: CanvasRenderingContext2D,
    cLandX: number, cLandY: number,
    f: number,
  ) {
    const fullText  = 'I Better Power Down, there are civilians around'
    const charCount = Math.min(fullText.length, Math.floor((f - 600) / 1.2))
    const dispText  = fullText.slice(0, charCount)
    const dAlpha    = Math.min(1, (f - 600) / 20)
    const bx = Math.min(CANVAS_W - 158, Math.max(2, cLandX - 74))
    const by = cLandY - SPR_H - 40
    ctx.globalAlpha = dAlpha
    ctx.fillStyle   = 'rgba(0,0,0,0.88)'
    ctx.strokeStyle = '#4499ff'
    ctx.lineWidth   = 1.5
    ctx.beginPath()
    ctx.rect(bx, by, 154, 33)
    ctx.fill(); ctx.stroke()
    ctx.fillStyle = '#ffffff'
    ctx.font      = '7px monospace'
    ctx.textAlign = 'left'
    ctx.fillText(dispText.slice(0, 25), bx + 5, by + 12)
    if (dispText.length > 25) ctx.fillText(dispText.slice(25), bx + 5, by + 24)
    ctx.fillStyle   = 'rgba(0,0,0,0.88)'
    ctx.strokeStyle = '#4499ff'
    ctx.beginPath()
    ctx.moveTo(cLandX + TILE / 2 - 4, by + 33)
    ctx.lineTo(cLandX + TILE / 2 + 8, by + 33)
    ctx.lineTo(cLandX + TILE / 2 + 2, cLandY - SPR_H + 6)
    ctx.closePath()
    ctx.fill(); ctx.stroke()
    ctx.globalAlpha = 1
  }
}
