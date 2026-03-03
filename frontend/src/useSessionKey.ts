import { useState, useCallback } from 'react'
import { useWriteContract, usePublicClient, useSendTransaction } from 'wagmi'
import { parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { CDB_ABI } from './abi'
import { CONTRACT_ADDRESS } from './wagmi'

export type SessionKeyStatus =
  | 'none'          // no session key generated yet
  | 'authorizing'   // MetaMask tx 1: authorizeSessionKey
  | 'confirming'    // waiting for authorizeSessionKey receipt
  | 'funding'       // MetaMask tx 2: send ETH to session key
  | 'funding_confirm' // waiting for ETH send receipt
  | 'ready'         // authorized + funded — game can start
  | 'error'

const STORAGE_KEY = (runId: bigint) => `cdb_sk_${runId.toString()}`

// 0.001 ETH — enough for ~100+ moves at typical Base Sepolia gas prices
const SESSION_KEY_FUND = parseEther('0.001')

/**
 * Manages an ephemeral session key for a run.
 *
 * Setup flow (two MetaMask confirmations, one time per run):
 *  1. authorizeSessionKey(runId, sessionKeyAddress) — binds the key on-chain
 *  2. sendTransaction({ to: sessionKeyAddress, value: 0.001 ETH }) — gas money
 *
 * After setup, moves are submitted silently by useSubmitMove with no popups.
 */
export function useSessionKey(runId: bigint) {
  const [status, setStatus] = useState<SessionKeyStatus>(() => {
    const existing = localStorage.getItem(STORAGE_KEY(runId))
    return existing ? 'ready' : 'none'
  })
  const [error, setError] = useState<string | undefined>()
  const [sessionPrivateKey, setSessionPrivateKey] = useState<`0x${string}` | undefined>(() => {
    const stored = localStorage.getItem(STORAGE_KEY(runId))
    return stored ? (stored as `0x${string}`) : undefined
  })

  const { writeContractAsync }   = useWriteContract()
  const { sendTransactionAsync } = useSendTransaction()
  const publicClient             = usePublicClient()!

  const generateAndAuthorize = useCallback(async () => {
    setError(undefined)
    try {
      const pk      = generatePrivateKey()
      const account = privateKeyToAccount(pk)

      // ── Tx 1: register session key on-chain ──────────────────────────────
      setStatus('authorizing')
      const authHash = await writeContractAsync({
        address:      CONTRACT_ADDRESS,
        abi:          CDB_ABI,
        functionName: 'authorizeSessionKey',
        args:         [runId, account.address],
        gas:          80000n,
      })

      setStatus('confirming')
      await publicClient.waitForTransactionReceipt({ hash: authHash })

      // ── Tx 2: fund the session key with gas money ─────────────────────────
      setStatus('funding')
      const fundHash = await sendTransactionAsync({
        to:    account.address,
        value: SESSION_KEY_FUND,
      })

      setStatus('funding_confirm')
      await publicClient.waitForTransactionReceipt({ hash: fundHash })

      // Persist private key only after both txs confirm
      localStorage.setItem(STORAGE_KEY(runId), pk)
      setSessionPrivateKey(pk)
      setStatus('ready')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }, [runId, writeContractAsync, sendTransactionAsync, publicClient])

  function reset() {
    localStorage.removeItem(STORAGE_KEY(runId))
    setSessionPrivateKey(undefined)
    setStatus('none')
    setError(undefined)
  }

  const sessionAddress = sessionPrivateKey
    ? privateKeyToAccount(sessionPrivateKey).address
    : undefined

  return { status, error, sessionPrivateKey, sessionAddress, generateAndAuthorize, reset }
}
