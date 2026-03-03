import { createConfig, http } from 'wagmi'
import { createPublicClient } from 'viem'
import { baseSepolia } from 'wagmi/chains'
import { baseSepolia as viemBaseSepolia } from 'viem/chains'
import { injected, coinbaseWallet } from 'wagmi/connectors'

export const config = createConfig({
  chains: [baseSepolia],
  transports: {
    [baseSepolia.id]: http(),
  },
  connectors: [
    injected(),
    coinbaseWallet({ appName: 'Captain Down Bad' }),
  ],
})

export const CONTRACT_ADDRESS = '0x4aeD1b5acDc038c766993C924B36D1c5D03d7712' as const
export const USDC_ADDRESS     = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const

export const publicClient = createPublicClient({
  chain:     viemBaseSepolia,
  transport: http(),
})
