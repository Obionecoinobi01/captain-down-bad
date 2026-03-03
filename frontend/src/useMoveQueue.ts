/**
 * useMoveQueue.ts
 *
 * Queues moves locally and flushes them to the chain as a batch.
 * Flush triggers when EITHER:
 *   - The queue reaches BATCH_SIZE moves, OR
 *   - FLUSH_INTERVAL ms have passed since the last flush
 *
 * After a batch confirms, calls onBatchConfirmed so the caller
 * can reconcile local physics with the chain state.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { publicClient, CONTRACT_ADDRESS } from './wagmi'
import { CDB_ABI } from './abi'
import type { Move } from './physics'

const BATCH_SIZE     = 5       // flush after this many moves
const FLUSH_INTERVAL = 3000    // or after this many ms (3s)

export type BatchStatus = 'idle' | 'sending' | 'confirming' | 'done' | 'error'

export interface UseMoveQueueReturn {
  /** Enqueue a move. Triggers local physics immediately via onMove callback. */
  enqueue:       (move: Move) => void
  batchStatus:   BatchStatus
  batchError:    string | null
  /** Number of moves queued but not yet submitted */
  pendingCount:  number
  /** Force an immediate flush (e.g. on run end) */
  flushNow:      () => void
}

interface Props {
  runId:            bigint
  sessionPrivateKey: `0x${string}` | null
  /** Called after a batch confirms on-chain — use to reconcile local state */
  onBatchConfirmed: () => void
  enabled:          boolean
}

export function useMoveQueue({
  runId,
  sessionPrivateKey,
  onBatchConfirmed,
  enabled,
}: Props): UseMoveQueueReturn {
  const queueRef       = useRef<Move[]>([])
  const flushingRef    = useRef(false)
  const timerRef       = useRef<ReturnType<typeof setTimeout> | null>(null)

  const [batchStatus,  setBatchStatus]  = useState<BatchStatus>('idle')
  const [batchError,   setBatchError]   = useState<string | null>(null)
  const [pendingCount, setPendingCount] = useState(0)

  const flush = useCallback(async () => {
    if (flushingRef.current)           return
    if (queueRef.current.length === 0) return
    if (!sessionPrivateKey)            return

    flushingRef.current = true
    const batch = queueRef.current.splice(0, queueRef.current.length)
    setPendingCount(0)
    setBatchStatus('sending')
    setBatchError(null)

    try {
      const account    = privateKeyToAccount(sessionPrivateKey)
      const walletClient = createWalletClient({
        account,
        chain:     baseSepolia,
        transport: http(),
      })

      const hash = await walletClient.writeContract({
        address:      CONTRACT_ADDRESS,
        abi:          CDB_ABI,
        functionName: 'submitMoveBatch',
        args:         [runId, batch as readonly number[]],
        gas:          100_000n + BigInt(batch.length) * 50_000n,
      })

      setBatchStatus('confirming')
      await publicClient.waitForTransactionReceipt({ hash })
      setBatchStatus('done')
      onBatchConfirmed()

      setTimeout(() => setBatchStatus('idle'), 1500)
    } catch (err) {
      // If tx failed, put moves back at front of queue so they aren't lost
      queueRef.current = [...batch, ...queueRef.current]
      setPendingCount(queueRef.current.length)
      setBatchStatus('error')
      setBatchError(err instanceof Error ? err.message : String(err))
      setTimeout(() => { setBatchStatus('idle'); setBatchError(null) }, 4000)
    } finally {
      flushingRef.current = false
    }
  }, [runId, sessionPrivateKey, onBatchConfirmed])

  const enqueue = useCallback((move: Move) => {
    if (!enabled) return
    queueRef.current.push(move)
    setPendingCount(queueRef.current.length)

    // Flush immediately when batch size reached
    if (queueRef.current.length >= BATCH_SIZE) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
      flush()
      return
    }

    // Otherwise (re)start the interval timer
    if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        flush()
      }, FLUSH_INTERVAL)
    }
  }, [enabled, flush])

  const flushNow = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    flush()
  }, [flush])

  // Clean up timer on unmount
  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  return { enqueue, batchStatus, batchError, pendingCount, flushNow }
}
