import { createConfig, http } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
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

export const CONTRACT_ADDRESS = '0x7AEAC202BCb996Ee193eCb1EE97cB71ABBdB7Dc8' as const
export const USDC_ADDRESS     = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
