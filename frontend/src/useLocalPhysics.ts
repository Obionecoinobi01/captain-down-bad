/**
 * useLocalPhysics.ts
 *
 * React hook that runs the TypeScript physics engine locally at 60fps.
 * The chain is NOT consulted during gameplay — moves apply instantly.
 * After each batch confirms on-chain, call syncFromChain() to reconcile.
 * If the chain state differs, local state snaps to chain truth (anti-cheat).
 */

import { useCallback, useRef, useState } from 'react'
import {
  advanceTick,
  buildInitialState,
  packState,
  unpackState,
  type Move,
  type PlayerState,
} from './physics'

export interface LocalGameState {
  player:           PlayerState
  clearedTiles:     Set<number>
  enemiesDefeated:  number        // uint8 bitmask — bit i = 1 means enemy i dead
  tick:             number
  active:           boolean
  won:              boolean
}

export interface UseLocalPhysicsReturn {
  /** Current local game state — read this for rendering, not chain state */
  localState:      LocalGameState
  /** Apply a move instantly. Returns the updated state. */
  applyMove:       (move: Move) => LocalGameState
  /**
   * Reconcile local state with chain-confirmed state.
   * Call after each batch tx confirms.
   * If states match — no-op. If they differ — snap to chain (chain wins).
   */
  syncFromChain:   (
    chainPlayerState:     bigint,
    chainTick:            number,
    chainCleared:         Set<number>,
    chainEnemiesDefeated: number,
  ) => void
  /** Reset to initial state (new run started). */
  reset:           (initialPlayerState?: bigint) => void
  /** Whether the last sync found a desync (useful for debug overlay). */
  desynced:        boolean
}

function makeInitialLocalState(packed?: bigint): LocalGameState {
  return {
    player:          packed !== undefined ? unpackState(packed) : buildInitialState(),
    clearedTiles:    new Set<number>(),
    enemiesDefeated: 0,
    tick:            0,
    active:          true,
    won:             false,
  }
}

export function useLocalPhysics(initialPlayerState?: bigint): UseLocalPhysicsReturn {
  const [localState, setLocalState] = useState<LocalGameState>(() =>
    makeInitialLocalState(initialPlayerState)
  )
  const [desynced, setDesynced] = useState(false)

  // Keep a ref in sync so applyMove closure always reads latest
  const stateRef = useRef<LocalGameState>(localState)
  stateRef.current = localState

  const applyMove = useCallback((move: Move): LocalGameState => {
    const gs = stateRef.current
    if (!gs.active) return gs

    const result = advanceTick(gs.player, gs.clearedTiles, move, gs.enemiesDefeated, gs.tick)

    const next: LocalGameState = {
      player:          result.state,
      clearedTiles:    result.clearedTiles,
      enemiesDefeated: result.enemiesDefeated,
      tick:            gs.tick + 1,
      active:          !result.ended,
      won:             result.won,
    }

    stateRef.current = next
    setLocalState(next)
    return next
  }, [])

  const syncFromChain = useCallback((
    chainPlayerState:     bigint,
    chainTick:            number,
    chainCleared:         Set<number>,
    chainEnemiesDefeated: number,
  ) => {
    const local = stateRef.current
    const localPacked = packState(local.player)

    // If everything matches — in sync, nothing to do
    if (
      localPacked === chainPlayerState &&
      local.tick  === chainTick &&
      local.enemiesDefeated === chainEnemiesDefeated
    ) {
      setDesynced(false)
      return
    }

    // Desync detected — chain wins, snap local to chain state
    console.warn('[physics] desync detected — snapping to chain state', {
      localTick:    local.tick,
      chainTick,
      localState:   local.player,
      chainState:   unpackState(chainPlayerState),
      localEnemies: local.enemiesDefeated,
      chainEnemies: chainEnemiesDefeated,
    })

    const snapped: LocalGameState = {
      player:          unpackState(chainPlayerState),
      clearedTiles:    chainCleared,
      enemiesDefeated: chainEnemiesDefeated,
      tick:            chainTick,
      active:          local.active,
      won:             local.won,
    }

    stateRef.current = snapped
    setLocalState(snapped)
    setDesynced(true)

    setTimeout(() => setDesynced(false), 1000)
  }, [])

  const reset = useCallback((packed?: bigint) => {
    const fresh = makeInitialLocalState(packed)
    stateRef.current = fresh
    setLocalState(fresh)
    setDesynced(false)
  }, [])

  return { localState, applyMove, syncFromChain, reset, desynced }
}
