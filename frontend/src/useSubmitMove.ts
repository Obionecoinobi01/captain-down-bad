import { useState, useCallback } from 'react'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { usePublicClient } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { CDB_ABI } from './abi'
import { CONTRACT_ADDRESS } from './wagmi'

// Move enum — must match contract: Idle=0 Left=1 Right=2 Jump=3 Punch=4 Kick=5
export type Move = 0 | 1 | 2 | 3 | 4 | 5
export const MOVE_LABELS: Record<Move, string> = {
  0: '• IDLE',
  1: '← LEFT',
  2: '→ RIGHT',
  3: '↑ JUMP',
  4: '✊ PUNCH',
  5: '⚡ KICK',
}

export type MoveStatus = 'idle' | 'sending' | 'confirming' | 'done' | 'error'

/**
 * Submits a move via the session key — no MetaMask popup.
 * The session key private key is held in localStorage and passed in
 * from useSessionKey.
 */
export function useSubmitMove(runId: bigint, sessionPrivateKey: `0x${string}` | undefined) {
  const [moveStatus, setMoveStatus] = useState<MoveStatus>('idle')
  const [error, setError]           = useState<string | undefined>()
  const publicClient = usePublicClient()!

  const submitMove = useCallback(async (move: Move) => {
    if (!sessionPrivateKey) {
      setError('No session key — authorize one first')
      return
    }
    if (moveStatus === 'sending' || moveStatus === 'confirming') return

    setError(undefined)
    setMoveStatus('sending')

    try {
      const account = privateKeyToAccount(sessionPrivateKey)

      // Build a walletClient backed by the ephemeral private key — no MetaMask
      const walletClient = createWalletClient({
        account,
        chain:     baseSepolia,
        transport: http(),
      })

      const txHash = await walletClient.writeContract({
        address:      CONTRACT_ADDRESS,
        abi:          CDB_ABI,
        functionName: 'submitMove',
        args:         [runId, move],
        gas:          200000n,
      })

      setMoveStatus('confirming')
      await publicClient.waitForTransactionReceipt({ hash: txHash })
      setMoveStatus('done')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setMoveStatus('error')
    }
  }, [runId, sessionPrivateKey, moveStatus, publicClient])

  function resetMove() {
    setMoveStatus('idle')
    setError(undefined)
  }

  return { submitMove, moveStatus, error, resetMove }
}
