/**
 * game/types.ts — Shared bridge between React (GameScreen.tsx) and Phaser Scenes.
 *
 * React owns all state (hooks, Web3, input). Phaser Scenes read from the bridge.
 * Direct MutableRefObject sharing means no stale-closure issues on either side.
 */
import type { LocalGameState } from '../useLocalPhysics'
import type { Move, LevelConfig } from '../physics'

export interface GameBridge {
  // ── State (React → Phaser, read-only from Phaser) ───────────────────────────
  getState:   () => LocalGameState   // latest local physics state
  level:      LevelConfig            // active level config

  // ── Input state (written by keydown, read by GameScene for rendering) ────────
  lastMove:   { current: Move | null }
  facing:     { current: number }     // 1 = right, -1 = left
  canMove:    { current: boolean }

  // ── Visual effects state (shared mutable refs) ───────────────────────────────
  frame:      { current: number }     // global animation frame counter
  hitstop:    { current: number }     // remaining freeze frames (> 0 = frozen)
  hitSpark:   { current: { tx: number; ty: number; combo: number } | null }
  combo:      { current: { count: number; resetAt: number; displayFrames: number } }
  hurtFrames: { current: number }     // frames remaining for hurt animation
  effects:    { current: { hitFlash: number; defFlash: number; glitch: number } }
  requestShake: { current: { intensity: number; duration: number } | null }

  // ── Sprite sources (loaded async in React, added to Phaser textures once ready)
  sprites: {
    captainWalk:    { current: HTMLCanvasElement | null }
    captainActions: { current: HTMLCanvasElement | null }
    enemyTroll:     { current: HTMLCanvasElement | null }
    enemyDemon:     { current: HTMLCanvasElement | null }
    boss:           { current: HTMLCanvasElement | null }
  }

  // ── Auto-gravity callback (GameScene → React) ────────────────────────────────
  onAutoGrav: () => void   // calls applyMove(Idle) + enqueue(Idle)

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  onIntroEnd: () => void   // called by IntroScene when 700-frame animation finishes
}
