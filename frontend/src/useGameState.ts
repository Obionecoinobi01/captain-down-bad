import { useReadContract, usePublicClient } from 'wagmi'
import { formatUnits, parseAbiItem } from 'viem'
import { useCallback } from 'react'
import { CDB_ABI, ERC20_ABI } from './abi'
import { CONTRACT_ADDRESS, USDC_ADDRESS } from './wagmi'

// Deployment block of the current contract — used as lower bound for log queries
const DEPLOY_BLOCK = 38382637n

/** Unpack the uint256 player state into readable fields */
export function unpackState(packed: bigint) {
  return {
    posX:      Number((packed >> 248n) & 0xffn),
    posY:      Number((packed >> 240n) & 0xffn),
    velY:      Number(BigInt.asIntN(8, (packed >> 232n) & 0xffn)),
    health:    Number((packed >> 224n) & 0xffn),
    animFrame: Number((packed >> 216n) & 0xffn),
    score:     (packed & 0xffffffffffffffn),
  }
}

export function useHouseFeeBps() {
  const { data } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CDB_ABI,
    functionName: 'HOUSE_FEE_BPS',
  })
  return data !== undefined ? Number(data) / 100 : 1
}

export function useRun(runId: bigint | undefined) {
  const { data, isLoading, refetch } = useReadContract({
    address: CONTRACT_ADDRESS,
    abi: CDB_ABI,
    functionName: 'runs',
    args: runId !== undefined ? [runId] : undefined,
    query: { enabled: runId !== undefined },
  })

  // New Run struct (7 fields): player, levelId, bet, tick, playerState, active, finalScore
  const state = data && data[4] !== undefined ? unpackState(data[4]) : null

  return {
    run: data
      ? {
          player:      data[0],
          levelId:     data[1],
          bet:         data[2],
          tick:        data[3],
          playerState: data[4],
          active:      data[5],
          finalScore:  data[6],
        }
      : null,
    state,
    isLoading,
    refetch,
  }
}

/**
 * Returns a function that fetches all GemCollected events for a run and
 * returns a Set of "x,y" strings for cleared positions.
 */
export function useGemEventFetcher(runId: bigint) {
  const publicClient = usePublicClient()!

  const fetchClearedGems = useCallback(async (): Promise<Set<string>> => {
    const logs = await publicClient.getLogs({
      address: CONTRACT_ADDRESS,
      event: parseAbiItem(
        'event GemCollected(uint256 indexed runId, uint8 posX, uint8 posY, uint256 newScore)'
      ),
      args: { runId },
      fromBlock: DEPLOY_BLOCK,
      toBlock:   'latest',
    })
    const cleared = new Set<string>()
    for (const log of logs) {
      cleared.add(`${log.args.posX},${log.args.posY}`)
    }
    return cleared
  }, [runId, publicClient])

  return fetchClearedGems
}

export function useUsdcBalance(address: `0x${string}` | undefined) {
  const { data } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })
  return {
    raw: data ?? 0n,
    formatted: data ? formatUnits(data, 6) : '0.00',
  }
}

export function useUsdcAllowance(owner: `0x${string}` | undefined) {
  const { data, refetch } = useReadContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: owner ? [owner, CONTRACT_ADDRESS] : undefined,
    query: { enabled: !!owner },
  })
  return { raw: data ?? 0n, refetch }
}
