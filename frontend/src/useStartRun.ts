import { useState } from 'react'
import { useWriteContract, usePublicClient, useReadContract } from 'wagmi'
import { parseUnits, parseEventLogs } from 'viem'
import { CDB_ABI, ERC20_ABI } from './abi'
import { CONTRACT_ADDRESS, USDC_ADDRESS } from './wagmi'

export type StartRunStatus =
  | 'idle'
  | 'approving'
  | 'approve_pending'
  | 'starting'
  | 'start_pending'
  | 'done'
  | 'error'

export function useStartRun(address: `0x${string}` | undefined) {
  const [status, setStatus] = useState<StartRunStatus>('idle')
  const [runId, setRunId] = useState<bigint | undefined>()
  const [error, setError] = useState<string | undefined>()

  const { writeContractAsync } = useWriteContract()
  const publicClient = usePublicClient()

  const { refetch: refetchAllowance } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, CONTRACT_ADDRESS] : undefined,
    query: { enabled: !!address },
  })

  async function startRun(betUsdc: string, levelId: bigint = 0n) {
    if (!address || !publicClient) return
    setError(undefined)

    try {
      const betRaw = parseUnits(betUsdc, 6)

      // 1. Check allowance — approve if insufficient
      const { data: currentAllowance } = await refetchAllowance()
      if ((currentAllowance ?? 0n) < betRaw) {
        setStatus('approving')
        const approveTxHash = await writeContractAsync({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [CONTRACT_ADDRESS, betRaw],
        })
        setStatus('approve_pending')
        await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
      }

      // 2. Start the run
      setStatus('starting')
      const startTxHash = await writeContractAsync({
        address: CONTRACT_ADDRESS,
        abi: CDB_ABI,
        functionName: 'startRun',
        args: [betRaw, levelId],
        gas: 500000n,
      })
      setStatus('start_pending')
      const receipt = await publicClient.waitForTransactionReceipt({ hash: startTxHash })

      // 3. Parse runId from RunStarted event
      const logs = parseEventLogs({ abi: CDB_ABI, eventName: 'RunStarted', logs: receipt.logs })
      setRunId(logs[0].args.runId)
      setStatus('done')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setStatus('error')
    }
  }

  function reset() {
    setStatus('idle')
    setRunId(undefined)
    setError(undefined)
  }

  return { startRun, status, runId, error, reset }
}
