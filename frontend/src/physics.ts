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
export const TILE_ENEMY = 4   // static enemy (custom levels); level 0 uses dynamic patrol

// Move enum — matches Solidity: enum Move { Idle, Left, Right, Jump, Punch, Kick }
export const Move = { Idle: 0, Left: 1, Right: 2, Jump: 3, Punch: 4, Kick: 5 } as const
export type  Move = typeof Move[keyof typeof Move]

// ── Level config ───────────────────────────────────────────────────────────────
export interface LevelConfig {
  id:               number
  map:              Uint8Array
  gemCount:         number
  gemIndices:       readonly number[]
  spawnX:           number
  spawnY:           number
  // Dynamic enemies (level 0 only). For levels with static tile-4 enemies, enemyCount = 0.
  enemyCount:       number
  enemyY:           readonly number[]
  enemyPatrolMin:   readonly number[]
  enemyPatrolMax:   readonly number[]
  enemyPatrolSpeed: readonly number[]
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function parseHexMap(hex: string): Uint8Array {
  const arr = new Uint8Array(LEVEL_WIDTH * LEVEL_HEIGHT)
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return arr
}

// ── Level 0 — built-in, exact copy of LEVEL_MAP_BYTES in contract ──────────────
// NOTE: tile 4 (enemy) removed from map; level-0 enemies are dynamic patrol.
const LEVEL_0_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=0
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=1
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=2
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=3
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=4
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=5
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=6
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=7
  '0000000000000000000002000200000000000000000000000000000000000000' + // y=8  gems x=10,12
  '0000000000000000010101010101010000000000000000000000000000000000' + // y=9  platform x=8..13
  '0000000000000000000000000000000000000200020000000000000000000000' + // y=10 gems x=18,20
  '0000000000000000000000000000000001010101010101000000000000000000' + // y=11 platform x=16..22
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=12
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=13
  '0000000000030000000000000000000000000000000000000003000000000000' + // y=14 spikes x=5,25
  '0101010101010101010101010101010101010101010101010101010101010101'   // y=15 ground

// ── Level 1 — "Sky Towers" ─────────────────────────────────────────────────────
// Three-tier vertical layout. Static enemies (tile 04) guard low platforms.
//
// Tier layout (player standing rows, wall rows):
//   High:   player y=2  │  wall y=3   x=12..18
//   Mid:    player y=5  │  wall y=6   x=3..9  and  x=22..28
//   Low:    player y=8  │  wall y=9   x=4..10 and  x=20..26
//   Ground: player y=14 │  wall y=15  (full)
//
// Gems (must collect all 4 to win):
//   y=2 x=14, y=2 x=16   (high platform)
//   y=5 x=5,  y=5 x=24   (mid platforms)
//
// Static enemies (tile 04) at y=8: x=9 (left low), x=23 (right low)
// Spikes at y=14: x=2, x=29
const LEVEL_1_HEX =
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=0  air
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=1  air
  '0000000000000000000000000000020002000000000000000000000000000000' + // y=2  gems x=14,16
  '0000000000000000000000000101010101010100000000000000000000000000' + // y=3  platform x=12..18
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=4  air
  '0000000000020000000000000000000000000000000000000200000000000000' + // y=5  gems x=5,24
  '0000000001010101010101000000000000000000000001010101010101000000' + // y=6  platforms x=3..9, x=22..28
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=7  air
  '0000000000000000000400000000000000000000000000040000000000000000' + // y=8  enemies x=9,23
  '0000000001010101010101000000000000000001010101010101000000000000' + // y=9  platforms x=4..10, x=20..26
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=10 air
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=11 air
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=12 air
  '0000000000000000000000000000000000000000000000000000000000000000' + // y=13 air
  '0000030000000000000000000000000000000000000000000000000000030000' + // y=14 spikes x=2,29
  '0101010101010101010101010101010101010101010101010101010101010101'   // y=15 ground

// ── Level configs ──────────────────────────────────────────────────────────────

export const LEVEL_0: LevelConfig = {
  id:               0,
  map:              parseHexMap(LEVEL_0_HEX),
  gemCount:         4,
  gemIndices:       [
    8  * 32 + 10,  // (x=10, y=8)
    8  * 32 + 12,  // (x=12, y=8)
    10 * 32 + 18,  // (x=18, y=10)
    10 * 32 + 20,  // (x=20, y=10)
  ],
  spawnX:           2,
  spawnY:           14,
  enemyCount:       2,
  enemyY:           [8, 14],
  enemyPatrolMin:   [8,  6],
  enemyPatrolMax:   [14, 24],
  enemyPatrolSpeed: [2,  3],
}

export const LEVEL_1: LevelConfig = {
  id:               1,
  map:              parseHexMap(LEVEL_1_HEX),
  gemCount:         4,
  gemIndices:       [
    2 * 32 + 14,   // (x=14, y=2)
    2 * 32 + 16,   // (x=16, y=2)
    5 * 32 + 5,    // (x=5,  y=5)
    5 * 32 + 24,   // (x=24, y=5)
  ],
  spawnX:           2,
  spawnY:           14,
  enemyCount:       0,   // enemies are static tile-4 in the map
  enemyY:           [],
  enemyPatrolMin:   [],
  enemyPatrolMax:   [],
  enemyPatrolSpeed: [],
}

export const LEVELS: readonly LevelConfig[] = [LEVEL_0, LEVEL_1]

export function getLevel(id: number): LevelConfig {
  return LEVELS.find(l => l.id === id) ?? LEVEL_0
}

// ── Backward-compat exports (used by existing imports) ────────────────────────
export const LEVEL_MAP   = LEVEL_0.map
export const GEM_INDICES = LEVEL_0.gemIndices
export const ENEMY_COUNT = LEVEL_0.enemyCount

// ── Enemy patrol ───────────────────────────────────────────────────────────────

/** Compute enemy X position for level-0 dynamic enemies — pure function of (idx, tick). */
export function enemyPosX(idx: number, tick: number): number {
  const pMin  = LEVEL_0.enemyPatrolMin[idx]
  const pMax  = LEVEL_0.enemyPatrolMax[idx]
  const spd   = LEVEL_0.enemyPatrolSpeed[idx]
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
 * Returns current positions of dynamic enemies for the given level.
 * Returns empty array for levels that use static tile-4 enemies instead.
 */
export function getEnemyPositions(
  enemiesDefeated: number,
  tick: number,
  level: LevelConfig = LEVEL_0,
): EnemyPosition[] {
  if (level.enemyCount === 0) return []
  const result: EnemyPosition[] = []
  for (let i = 0; i < level.enemyCount; i++) {
    const pMin   = level.enemyPatrolMin[i]
    const pMax   = level.enemyPatrolMax[i]
    const spd    = level.enemyPatrolSpeed[i]
    const range  = pMax - pMin
    const phase  = Math.floor(tick / spd) % (range * 2)
    const offset = phase <= range ? phase : range * 2 - phase
    const ePosX  = pMin + offset
    const alive  = ((enemiesDefeated >> i) & 1) === 0
    const facing = phase <= range ? 1 : -1
    result.push({
      posX:  alive ? ePosX : -1,
      posY:  level.enemyY[i],
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
  enemiesDefeated:  number        // updated uint8 bitmask (dynamic enemies only)
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

/** Spawn position for the given level. */
export function buildInitialState(level: LevelConfig = LEVEL_0): PlayerState {
  return { posX: level.spawnX, posY: level.spawnY, velY: 0, health: INITIAL_HEALTH, animFrame: 0, score: 0 }
}

// ── Tile lookup ────────────────────────────────────────────────────────────────
function getTileAt(map: Uint8Array, cleared: Set<number>, x: number, y: number): number {
  if (x < 0 || x >= LEVEL_WIDTH || y < 0 || y >= LEVEL_HEIGHT) return TILE_AIR
  const idx = y * LEVEL_WIDTH + x
  if (cleared.has(idx)) return TILE_AIR
  return map[idx]
}

// ── Core tick — exact mirror of _advanceTick() ────────────────────────────────
/**
 * Apply one game tick. Pure function — returns new state, never mutates inputs.
 * Order: horizontal → jump → gravity → clamp → velY → tile collision → enemy collision → repack.
 *
 * @param enemiesDefeated  uint8 bitmask — bit i = 1 means dynamic enemy i is dead
 * @param tick             current tick (BEFORE this advance — matches run.tick in contract)
 * @param level            level config (defaults to LEVEL_0)
 */
export function advanceTick(
  state:            PlayerState,
  clearedTiles:     Set<number>,
  move:             Move,
  enemiesDefeated:  number,
  tick:             number,
  level:            LevelConfig = LEVEL_0,
): TickResult {
  let { posX, posY, velY, health, animFrame, score } = state
  const cleared = new Set(clearedTiles)   // don't mutate caller's set
  const map     = level.map
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

  // Sweep intermediate rows to prevent tunneling through platforms
  if (velY !== 0) {
    const dir = velY < 0 ? 1 : -1   // falling (velY<0) → posY increases → dir +1
    for (let iy = prevPosY + dir; dir > 0 ? iy <= nextY : iy >= nextY; iy += dir) {
      if (getTileAt(map, cleared, posX, iy) === TILE_WALL) {
        nextY = iy - dir   // stop just before wall
        velY = 0
        break
      }
    }
  }
  posY = nextY

  // --- Tile collision (destination effects: gem, spike, wall fallback, static enemy) ---
  const tile = getTileAt(map, cleared, posX, posY)

  if (tile === TILE_WALL) {
    posY = prevPosY
    velY = 0
  } else if (tile === TILE_GEM) {
    score += GEM_SCORE
    cleared.add(posY * LEVEL_WIDTH + posX)
    gemCollected = true
  } else if (tile === TILE_SPIKE) {
    if (health > 0) health--
  } else if (tile === TILE_ENEMY) {
    // Static enemy tile — matches contract: punch/kick = defeat; otherwise = damage
    if (move === Move.Punch || move === Move.Kick) {
      score += ENEMY_SCORE
      cleared.add(posY * LEVEL_WIDTH + posX)
      enemyDefeated = true
    } else {
      if (health > 0) health--
    }
  }

  // --- Dynamic enemy collision (level 0 only) ---
  if (level.enemyCount > 0) {
    for (let i = 0; i < level.enemyCount; i++) {
      if ((def >> i) & 1) continue          // already defeated
      const pMin  = level.enemyPatrolMin[i]
      const pMax  = level.enemyPatrolMax[i]
      const spd   = level.enemyPatrolSpeed[i]
      const range  = pMax - pMin
      const phase  = Math.floor(tick / spd) % (range * 2)
      const offset = phase <= range ? phase : range * 2 - phase
      const ePosX  = pMin + offset
      const ePosY  = level.enemyY[i]
      if (move === Move.Punch || move === Move.Kick) {
        // Attack has ±1 tile reach (player can punch from adjacent tile)
        if (Math.abs(posX - ePosX) <= 1 && posY === ePosY) {
          def = def | (1 << i)
          score += ENEMY_SCORE
          enemyDefeated = true
          break
        }
      } else if (posX === ePosX && posY === ePosY) {
        if (health > 0) health--
        break
      }
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

  const allGemsCleared = level.gemIndices.every(idx => cleared.has(idx))
  if (allGemsCleared) {
    return { state: newState, clearedTiles: cleared, enemiesDefeated: def, ended: true, won: true, gemCollected, enemyDefeated }
  }

  return { state: newState, clearedTiles: cleared, enemiesDefeated: def, ended: false, won: false, gemCollected, enemyDefeated }
}
