import type { ChainDeployment } from "./types"

const empty = { address: "" as const, block: 0, txHash: "" as const }

const DEPLOYMENTS: Record<number, ChainDeployment> = {
  1:        { chainId: 1,        network: "mainnet",          env: "mainnet", deployedAt: "", InvisiPool: empty, SingleWithdrawVerifier: empty, BatchWithdrawVerifier: empty, ShieldedPaymentVerifier: empty },
  10:       { chainId: 10,       network: "optimism",         env: "mainnet", deployedAt: "", InvisiPool: empty, SingleWithdrawVerifier: empty, BatchWithdrawVerifier: empty, ShieldedPaymentVerifier: empty },
  8453:     { chainId: 8453,     network: "base",             env: "mainnet", deployedAt: "", InvisiPool: empty, SingleWithdrawVerifier: empty, BatchWithdrawVerifier: empty, ShieldedPaymentVerifier: empty },
  42161:    { chainId: 42161,    network: "arbitrum",         env: "mainnet", deployedAt: "", InvisiPool: empty, SingleWithdrawVerifier: empty, BatchWithdrawVerifier: empty, ShieldedPaymentVerifier: empty },
  11155111: { chainId: 11155111, network: "sepolia",          env: "testnet", deployedAt: "", InvisiPool: empty, SingleWithdrawVerifier: empty, BatchWithdrawVerifier: empty, ShieldedPaymentVerifier: empty },
  11155420: { chainId: 11155420, network: "optimism-sepolia", env: "testnet", deployedAt: "", InvisiPool: empty, SingleWithdrawVerifier: empty, BatchWithdrawVerifier: empty, ShieldedPaymentVerifier: empty },
  84532:    { chainId: 84532,    network: "base-sepolia",     env: "testnet", deployedAt: "", InvisiPool: empty, SingleWithdrawVerifier: empty, BatchWithdrawVerifier: empty, ShieldedPaymentVerifier: empty },
  421614:   { chainId: 421614,   network: "arbitrum-sepolia", env: "testnet", deployedAt: "", InvisiPool: empty, SingleWithdrawVerifier: empty, BatchWithdrawVerifier: empty, ShieldedPaymentVerifier: empty },
}

export function getDeployment(chainId: number): ChainDeployment {
  const d = DEPLOYMENTS[chainId]
  if (!d) throw new Error(`Unsupported chainId: ${chainId}`)
  return d
}

export function getSupportedChainIds(): number[] {
  return Object.keys(DEPLOYMENTS).map(Number)
}
