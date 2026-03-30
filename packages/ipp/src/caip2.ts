const EIP155_PREFIX = "eip155:"

export interface NetworkInfo {
  name: string
  caip2: string
  chainId: bigint
}

export const SUPPORTED_NETWORKS: NetworkInfo[] = [
  { name: "Ethereum", caip2: "eip155:1", chainId: 1n },
  { name: "Optimism", caip2: "eip155:10", chainId: 10n },
  { name: "Base", caip2: "eip155:8453", chainId: 8453n },
  { name: "Arbitrum", caip2: "eip155:42161", chainId: 42161n },
  { name: "Sepolia", caip2: "eip155:11155111", chainId: 11155111n },
  { name: "Optimism Sepolia", caip2: "eip155:11155420", chainId: 11155420n },
  { name: "Base Sepolia", caip2: "eip155:84532", chainId: 84532n },
  { name: "Arbitrum Sepolia", caip2: "eip155:421614", chainId: 421614n },
]

export function chainIdToCAIP2(chainId: bigint): string {
  return `${EIP155_PREFIX}${chainId}`
}

export function caip2ToChainId(network: string): bigint {
  if (!network.startsWith(EIP155_PREFIX)) {
    throw new Error(`Unsupported CAIP-2 namespace: ${network}`)
  }
  const idStr = network.slice(EIP155_PREFIX.length)
  if (!idStr || !/^\d+$/.test(idStr)) {
    throw new Error(`Invalid CAIP-2 identifier: ${network}`)
  }
  return BigInt(idStr)
}
