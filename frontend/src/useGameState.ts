import { useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { CDB_ABI, ERC20_ABI } from './abi'
import { CONTRACT_ADDRESS, USDC_ADDRESS } from './wagmi'

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
  // e.g. 100 bps = 1%
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

  // Struct order: player, levelId, bet, tick, revealDeadline, commit, playerState, active, finalScore
  const state = data && data[6] !== undefined ? unpackState(data[6]) : null

  return {
    run: data
      ? {
          player:         data[0],
          levelId:        data[1],
          bet:            data[2],
          tick:           data[3],
          revealDeadline: data[4],
          commit:         data[5],
          playerState:    data[6],
          active:         data[7],
          finalScore:     data[8],
        }
      : null,
    state,
    isLoading,
    refetch,
  }
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
