import type { PublicClient } from "viem"
import { invisiFactoryAbi } from "@invisi-labs/contracts"
import type { ChainDeployment } from "./types"

const empty = { address: "" as const, block: 0, txHash: "" as const }

const DEPLOYMENTS: Record<number, ChainDeployment> = {
  1:        { chainId: 1,        network: "mainnet",          env: "mainnet", deployedAt: "", InvisiFactory: empty, VerifierRouter: empty, SingleSettleVerifier: empty, BatchSettleVerifier: empty, ShieldedPaymentVerifier: empty, ProofLib: empty, creationCode: "", creationCodeHash: "" },
  10:       { chainId: 10,       network: "optimism",         env: "mainnet", deployedAt: "", InvisiFactory: empty, VerifierRouter: empty, SingleSettleVerifier: empty, BatchSettleVerifier: empty, ShieldedPaymentVerifier: empty, ProofLib: empty, creationCode: "", creationCodeHash: "" },
  8453:     { chainId: 8453,     network: "base",             env: "mainnet", deployedAt: "", InvisiFactory: empty, VerifierRouter: empty, SingleSettleVerifier: empty, BatchSettleVerifier: empty, ShieldedPaymentVerifier: empty, ProofLib: empty, creationCode: "", creationCodeHash: "" },
  42161:    { chainId: 42161,    network: "arbitrum",         env: "mainnet", deployedAt: "", InvisiFactory: empty, VerifierRouter: empty, SingleSettleVerifier: empty, BatchSettleVerifier: empty, ShieldedPaymentVerifier: empty, ProofLib: empty, creationCode: "", creationCodeHash: "" },
  11155111: { chainId: 11155111, network: "sepolia",          env: "testnet", deployedAt: "", InvisiFactory: empty, VerifierRouter: empty, SingleSettleVerifier: empty, BatchSettleVerifier: empty, ShieldedPaymentVerifier: empty, ProofLib: empty, creationCode: "", creationCodeHash: "" },
  11155420: { chainId: 11155420, network: "optimism-sepolia", env: "testnet", deployedAt: "", InvisiFactory: empty, VerifierRouter: empty, SingleSettleVerifier: empty, BatchSettleVerifier: empty, ShieldedPaymentVerifier: empty, ProofLib: empty, creationCode: "", creationCodeHash: "" },
  84532:    { chainId: 84532,    network: "base-sepolia",     env: "testnet", deployedAt: "", InvisiFactory: empty, VerifierRouter: empty, SingleSettleVerifier: empty, BatchSettleVerifier: empty, ShieldedPaymentVerifier: empty, ProofLib: empty, creationCode: "", creationCodeHash: "" },
  421614:   { chainId: 421614,   network: "arbitrum-sepolia", env: "testnet", deployedAt: "", InvisiFactory: empty, VerifierRouter: empty, SingleSettleVerifier: empty, BatchSettleVerifier: empty, ShieldedPaymentVerifier: empty, ProofLib: empty, creationCode: "", creationCodeHash: "" },
}

export function getDeployment(chainId: number): ChainDeployment {
  const d = DEPLOYMENTS[chainId]
  if (!d) throw new Error(`Unsupported chainId: ${chainId}`)
  return d
}

export function getSupportedChainIds(): number[] {
  return Object.keys(DEPLOYMENTS).map(Number)
}

/**
 * Resolve the per-token InvisiProtocol instance address via the Factory contract.
 * Calls `factory.getInstanceAddress(operator, token)` on-chain.
 */
export async function resolveInstanceAddress(
  client: PublicClient,
  factoryAddress: `0x${string}`,
  operator: `0x${string}`,
  token: `0x${string}`,
): Promise<`0x${string}`> {
  const instance = await client.readContract({
    abi: invisiFactoryAbi,
    address: factoryAddress,
    functionName: "getInstanceAddress",
    args: [operator, token],
  })
  return instance as `0x${string}`
}
