/**
 * physics.ts — Pure TypeScript mirror of CaptainDownBad.sol _advanceTick().
 *
 * Every constant, every operation, every branch must match the Solidity exactly.
 * This is the source of truth for local (60fps) prediction.
 * The chain reconciles after each batch — drift = desync = bad feel.
 *
 * Coordinate system (matching contract):
 *   posY increases downward (0 = top, 15 = bottom)
 *   velY uses physics sign: positive = up, negative = down
 *   Apply as: posY_new = posY - velY
 */

// ── Constants — must match contract exactly ────────────────────────────────────
export const LEVEL_WIDTH        = 32
export const LEVEL_HEIGHT       = 16
export const INITIAL_HEALTH     = 3
export const JUMP_IMPULSE       = 4
export const TERMINAL_VELOCITY  = -8
export const GEM_SCORE          = 100
export const ENEMY_SCORE        = 100

// Tile flags
export const TILE_AIR   = 0
export const TILE_WALL  = 1
export const TILE_GEM   = 2
export const TILE_SPIKE = 3
export const TILE_ENEMY = 4

// Move enum — matches Solidity: enum Move { Idle, Left, Right, Jump, Punch, Kick }
export const Move = { Idle: 0, Left: 1, Right: 2, Jump: 3, Punch: 4, Kick: 5 } as const
export type  Move = typeof Move[keyof typeof Move]

// ── Level 0 tile map — exact copy of LEVEL_MAP_BYTES from contract ────────────
const LEVEL_MAP_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=0
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=1
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=2
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=3
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=4
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=5
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=6
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=7
  '0000000000000000040002000200000000000000000000000000000000000000' + // y=8
  '0000000000000000010101010101010000000000000000000000000000000000' + // y=9
  '0000000000000000000000000000000000000200020000000000000000000000' + // y=10
  '0000000000000000000000000000000001010101010101000000000000000000' + // y=11
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=12
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=13
  '0000000000030000000000000000000400000000000000000003000000000000' + // y=14
  '0101010101010101010101010101010101010101010101010101010101010101'   // y=15

export const LEVEL_MAP: Uint8Array = (() => {
  const arr = new Uint8Array(LEVEL_WIDTH * LEVEL_HEIGHT)
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(LEVEL_MAP_HEX.slice(i * 2, i * 2 + 2), 16)
  }
  return arr
})()

// Gem tile indices (y * LEVEL_WIDTH + x) — matches GEM_IDX_0..3 in contract
export const GEM_INDICES = [
  8  * 32 + 10,  // (x=10, y=8)
  8  * 32 + 12,  // (x=12, y=8)
  10 * 32 + 18,  // (x=18, y=10)
  10 * 32 + 20,  // (x=20, y=10)
] as const

// ── Types ──────────────────────────────────────────────────────────────────────
export interface PlayerState {
  posX:      number   // uint8, 0..31
  posY:      number   // uint8, 0..15
  velY:      number   // int8,  -8..4
  health:    number   // uint8, 0..3
  animFrame: number   // uint8
  score:     number   // uint56 (safe as JS number up to 2^53)
}

export interface TickResult {
  state:        PlayerState
  clearedTiles: Set<number>   // updated set (immutable-style — new Set returned)
  ended:        boolean
  won:          boolean
  gemCollected: boolean
  enemyDefeated: boolean
}

// ── Bit-packing — mirrors Solidity helpers ─────────────────────────────────────
const POS_X_SHIFT  = 248n
const POS_Y_SHIFT  = 240n
const VEL_Y_SHIFT  = 232n
const HEALTH_SHIFT = 224n
const ANIM_SHIFT   = 216n
const SCORE_MASK   = (1n << 56n) - 1n

/** Unpack a contract uint256 playerState into a plain object. */
export function unpackState(packed: bigint): PlayerState {
  const posX      = Number((packed >> POS_X_SHIFT) & 0xffn)
  const posY      = Number((packed >> POS_Y_SHIFT) & 0xffn)
  const velYRaw   = Number((packed >> VEL_Y_SHIFT) & 0xffn)
  const velY      = velYRaw >= 128 ? velYRaw - 256 : velYRaw  // uint8 → int8
  const health    = Number((packed >> HEALTH_SHIFT) & 0xffn)
  const animFrame = Number((packed >> ANIM_SHIFT) & 0xffn)
  const score     = Number(packed & SCORE_MASK)
  return { posX, posY, velY, health, animFrame, score }
}

/** Pack a PlayerState into a uint256 bigint (for reconciliation comparison). */
export function packState(s: PlayerState): bigint {
  const velYu8 = BigInt((s.velY + 256) & 0xff)  // int8 → uint8
  return (BigInt(s.posX)      << POS_X_SHIFT)
       | (BigInt(s.posY)      << POS_Y_SHIFT)
       | (velYu8              << VEL_Y_SHIFT)
       | (BigInt(s.health)    << HEALTH_SHIFT)
       | (BigInt(s.animFrame) << ANIM_SHIFT)
       | BigInt(s.score)
}

/** Spawn position — matches _buildInitialState() in contract. */
export function buildInitialState(): PlayerState {
  return { posX: 2, posY: 14, velY: 0, health: INITIAL_HEALTH, animFrame: 0, score: 0 }
}

// ── Tile lookup ────────────────────────────────────────────────────────────────
function getTileAt(cleared: Set<number>, x: number, y: number): number {
  if (x < 0 || x >= LEVEL_WIDTH || y < 0 || y >= LEVEL_HEIGHT) return TILE_AIR
  const idx = y * LEVEL_WIDTH + x
  if (cleared.has(idx)) return TILE_AIR
  return LEVEL_MAP[idx]
}

// ── Core tick — exact mirror of _advanceTick() ────────────────────────────────
/**
 * Apply one game tick. Pure function — returns new state, never mutates inputs.
 * Order: horizontal move → jump → gravity → clamp → apply velY → collision → repack.
 */
export function advanceTick(
  state:        PlayerState,
  clearedTiles: Set<number>,
  move:         Move,
): TickResult {
  let { posX, posY, velY, health, animFrame, score } = state
  const cleared = new Set(clearedTiles)   // don't mutate caller's set
  let gemCollected  = false
  let enemyDefeated = false

  // --- Horizontal move ---
  if (move === Move.Left  && posX > 0)               posX--
  if (move === Move.Right && posX < LEVEL_WIDTH - 1) posX++

  // --- Jump (only when grounded: velY === 0) ---
  if (move === Move.Jump && velY === 0) velY = JUMP_IMPULSE

  // --- Gravity: mirrors `unchecked { velY--; }` ---
  // Safe: velY never below TERMINAL_VELOCITY so int8 wrap can't occur
  velY = velY - 1
  if (velY < TERMINAL_VELOCITY) velY = TERMINAL_VELOCITY

  // --- Apply vertical velocity (physics→screen: posY -= velY) ---
  const prevPosY = posY
  let nextY = posY - velY
  if (nextY < 0)            nextY = 0
  if (nextY >= LEVEL_HEIGHT) nextY = LEVEL_HEIGHT - 1
  posY = nextY

  // --- Tile collision ---
  const tile = getTileAt(cleared, posX, posY)

  if (tile === TILE_WALL) {
    posY = prevPosY   // revert vertical move into solid
    velY = 0          // land / hit ceiling
  } else if (tile === TILE_GEM) {
    score += GEM_SCORE
    cleared.add(posY * LEVEL_WIDTH + posX)
    gemCollected = true
  } else if (tile === TILE_SPIKE) {
    if (health > 0) health--
  } else if (tile === TILE_ENEMY) {
    if (move === Move.Punch || move === Move.Kick) {
      score += ENEMY_SCORE
      cleared.add(posY * LEVEL_WIDTH + posX)
      enemyDefeated = true
    } else {
      if (health > 0) health--
    }
  }

  // --- Attack animation ---
  if (move === Move.Punch || move === Move.Kick) {
    animFrame = (animFrame + 1) % 4
  }

  const newState: PlayerState = { posX, posY, velY, health, animFrame, score }

  // --- End conditions (mirrors contract order) ---
  if (health === 0) {
    return { state: newState, clearedTiles: cleared, ended: true, won: false, gemCollected, enemyDefeated }
  }

  const allGemsCleared = GEM_INDICES.every(idx => cleared.has(idx))
  if (allGemsCleared) {
    return { state: newState, clearedTiles: cleared, ended: true, won: true, gemCollected, enemyDefeated }
  }

  return { state: newState, clearedTiles: cleared, ended: false, won: false, gemCollected, enemyDefeated }
}
