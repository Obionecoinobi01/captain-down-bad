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

// Move enum — matches Solidity: enum Move { Idle, Left, Right, Jump, Punch, Kick }
export const Move = { Idle: 0, Left: 1, Right: 2, Jump: 3, Punch: 4, Kick: 5 } as const
export type  Move = typeof Move[keyof typeof Move]

// ── Level 0 tile map — exact copy of LEVEL_MAP_BYTES from contract ────────────
// NOTE: tile 4 (enemy) has been removed from the map; enemies are dynamic.
const LEVEL_MAP_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=0
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=1
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=2
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=3
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=4
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=5
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=6
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=7
  '0000000000000000000002000200000000000000000000000000000000000000' + // y=8  (enemy 0 removed)
  '0000000000000000010101010101010000000000000000000000000000000000' + // y=9
  '0000000000000000000000000000000000000200020000000000000000000000' + // y=10
  '0000000000000000000000000000000001010101010101000000000000000000' + // y=11
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=12
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=13
  '0000000000030000000000000000000000000000000000000003000000000000' + // y=14  (enemy 1 removed)
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

// ── Enemy patrol specs — must match contract constants exactly ────────────────
// Enemies patrol via ping-pong: posX = patrolMin + ping-pong(tick / speed)
export const ENEMY_COUNT = 2
const ENEMY_Y           = [8,  14] as const   // fixed Y row
const ENEMY_PATROL_MIN  = [8,   6] as const
const ENEMY_PATROL_MAX  = [14, 24] as const
const ENEMY_PATROL_SPEED = [2,   3] as const  // steps per tick

/** Compute enemy X position — pure function of (idx, tick). Matches _enemyPosX() in contract. */
export function enemyPosX(idx: number, tick: number): number {
  const pMin  = ENEMY_PATROL_MIN[idx]
  const pMax  = ENEMY_PATROL_MAX[idx]
  const spd   = ENEMY_PATROL_SPEED[idx]
  const range  = pMax - pMin
  const phase  = Math.floor(tick / spd) % (range * 2)
  const offset = phase <= range ? phase : range * 2 - phase
  return pMin + offset
}

export interface EnemyPosition {
  posX:   number
  posY:   number
  alive:  boolean
  facing: number   // 1 = facing right, -1 = facing left
}

/**
 * Returns current positions of all enemies.
 * @param enemiesDefeated  uint8 bitmask — bit i = 1 means enemy i is dead
 * @param tick             current game tick
 */
export function getEnemyPositions(enemiesDefeated: number, tick: number): EnemyPosition[] {
  const result: EnemyPosition[] = []
  for (let i = 0; i < ENEMY_COUNT; i++) {
    const alive  = ((enemiesDefeated >> i) & 1) === 0
    const pMin   = ENEMY_PATROL_MIN[i]
    const pMax   = ENEMY_PATROL_MAX[i]
    const spd    = ENEMY_PATROL_SPEED[i]
    const range  = pMax - pMin
    const phase  = Math.floor(tick / spd) % (range * 2)
    const facing = phase <= range ? 1 : -1   // increasing X = face right
    result.push({
      posX:  alive ? enemyPosX(i, tick) : -1,
      posY:  ENEMY_Y[i],
      alive,
      facing,
    })
  }
  return result
}

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
  state:            PlayerState
  clearedTiles:     Set<number>   // updated set (immutable-style — new Set returned)
  enemiesDefeated:  number        // updated uint8 bitmask
  ended:            boolean
  won:              boolean
  gemCollected:     boolean
  enemyDefeated:    boolean
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
 * Order: horizontal → jump → gravity → clamp → velY → tile collision → enemy collision → repack.
 *
 * @param enemiesDefeated  uint8 bitmask — bit i = 1 means enemy i is dead
 * @param tick             current tick (BEFORE this advance — matches run.tick in contract)
 */
export function advanceTick(
  state:            PlayerState,
  clearedTiles:     Set<number>,
  move:             Move,
  enemiesDefeated:  number,
  tick:             number,
): TickResult {
  let { posX, posY, velY, health, animFrame, score } = state
  const cleared = new Set(clearedTiles)   // don't mutate caller's set
  let def           = enemiesDefeated
  let gemCollected  = false
  let enemyDefeated = false

  // --- Horizontal move ---
  if (move === Move.Left  && posX > 0)               posX--
  if (move === Move.Right && posX < LEVEL_WIDTH - 1) posX++

  // --- Jump (only when grounded: velY === 0) ---
  if (move === Move.Jump && velY === 0) velY = JUMP_IMPULSE

  // --- Gravity: mirrors `unchecked { velY--; }` ---
  velY = velY - 1
  if (velY < TERMINAL_VELOCITY) velY = TERMINAL_VELOCITY

  // --- Apply vertical velocity (physics→screen: posY -= velY) ---
  const prevPosY = posY
  let nextY = posY - velY
  if (nextY < 0)             nextY = 0
  if (nextY >= LEVEL_HEIGHT) nextY = LEVEL_HEIGHT - 1
  posY = nextY

  // --- Tile collision ---
  const tile = getTileAt(cleared, posX, posY)

  if (tile === TILE_WALL) {
    posY = prevPosY
    velY = 0
  } else if (tile === TILE_GEM) {
    score += GEM_SCORE
    cleared.add(posY * LEVEL_WIDTH + posX)
    gemCollected = true
  } else if (tile === TILE_SPIKE) {
    if (health > 0) health--
  }

  // --- Enemy collision (dynamic patrol) — mirrors contract enemy loop ---
  // Uses `tick` (pre-increment) matching `run.tick` in _advanceTick before run.tick++
  for (let i = 0; i < ENEMY_COUNT; i++) {
    if ((def >> i) & 1) continue          // already defeated
    const ePosX = enemyPosX(i, tick)
    const ePosY = ENEMY_Y[i]
    if (move === Move.Punch || move === Move.Kick) {
      // Attack has ±1 tile reach (player can punch from adjacent tile)
      if (Math.abs(posX - ePosX) <= 1 && posY === ePosY) {
        def = def | (1 << i)
        score += ENEMY_SCORE
        enemyDefeated = true
        break
      }
    } else if (posX === ePosX && posY === ePosY) {
      // Damage zone: exact tile only (can't be hit from adjacent tile)
      if (health > 0) health--
      break
    }
  }

  // --- Attack animation ---
  if (move === Move.Punch || move === Move.Kick) {
    animFrame = (animFrame + 1) % 4
  }

  const newState: PlayerState = { posX, posY, velY, health, animFrame, score }

  // --- End conditions (mirrors contract order) ---
  if (health === 0) {
    return { state: newState, clearedTiles: cleared, enemiesDefeated: def, ended: true, won: false, gemCollected, enemyDefeated }
  }

  const allGemsCleared = GEM_INDICES.every(idx => cleared.has(idx))
  if (allGemsCleared) {
    return { state: newState, clearedTiles: cleared, enemiesDefeated: def, ended: true, won: true, gemCollected, enemyDefeated }
  }

  return { state: newState, clearedTiles: cleared, enemiesDefeated: def, ended: false, won: false, gemCollected, enemyDefeated }
}
