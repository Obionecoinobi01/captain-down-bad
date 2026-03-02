import { useState } from 'react'
import { useWriteContract, usePublicClient } from 'wagmi'
import { keccak256, encodePacked } from 'viem'
import { CDB_ABI } from './abi'
import { CONTRACT_ADDRESS } from './wagmi'

// Move enum: Idle=0, Left=1, Right=2, Jump=3, Punch=4, Kick=5
export type Move = 0 | 1 | 2 | 3 | 4 | 5
export const MOVE_LABELS: Record<Move, string> = {
  0: '• IDLE',
  1: '← LEFT',
  2: '→ RIGHT',
  3: '↑ JUMP',
  4: '✊ PUNCH',
  5: '⚡ KICK',
}

export type TxStatus =
  | 'idle'
  | 'committing'
  | 'commit_pending'
  | 'revealing'
  | 'reveal_pending'
  | 'done'
  | 'error'

export const TX_STATUS_LABEL: Record<TxStatus, string> = {
  idle:           '',
  committing:     'COMMITTING MOVE...',
  commit_pending: 'CONFIRMING COMMIT...',
  revealing:      'REVEALING...',
  reveal_pending: 'ADVANCING TICK...',
  done:           'TICK COMPLETE!',
  error:          '',
}

export function useCommitReveal(runId: bigint, address: `0x${string}` | undefined) {
  const [txStatus, setTxStatus] = useState<TxStatus>('idle')
  const [error, setError]       = useState<string | undefined>()

  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()!

  async function submitMove(move: Move) {
    if (txStatus !== 'idle' || !address) return
    setError(undefined)

    try {
      // Random 32-byte salt
      const saltRaw = crypto.getRandomValues(new Uint8Array(32))
      const salt = ('0x' + Array.from(saltRaw, b => b.toString(16).padStart(2, '0')).join('')) as `0x${string}`

      // commitHash = keccak256(abi.encodePacked(move, salt, player))
      const commitHash = keccak256(
        encodePacked(['uint8', 'bytes32', 'address'], [move, salt, address]),
      )

      // 1. Commit
      setTxStatus('committing')
      const commitTx = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: CDB_ABI,
        functionName: 'commitMove',
        args: [runId, commitHash],
        gas: 120000n,
      })
      setTxStatus('commit_pending')
      await publicClient.waitForTransactionReceipt({ hash: commitTx })

      // 2. Reveal (immediate — if contract requires waiting a block, this will revert and show error)
      setTxStatus('revealing')
      const revealTx = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: CDB_ABI,
        functionName: 'revealAndAdvance',
        args: [runId, move, salt],
        gas: 300000n,
      })
      setTxStatus('reveal_pending')
      await publicClient.waitForTransactionReceipt({ hash: revealTx })

      setTxStatus('done')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setTxStatus('error')
    }
  }

  function reset() {
    setTxStatus('idle')
    setError(undefined)
  }

  return { submitMove, txStatus, error, reset }
}
