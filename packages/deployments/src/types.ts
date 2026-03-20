export interface ContractDeployment {
  address: `0x${string}` | ""
  block: number
  txHash: `0x${string}` | ""
}

export interface ChainDeployment {
  chainId: number
  network: string
  env: "mainnet" | "testnet"
  deployedAt: string
  InvisiPool: ContractDeployment
  SingleWithdrawVerifier: ContractDeployment
  BatchWithdrawVerifier: ContractDeployment
  ShieldedPaymentVerifier: ContractDeployment
}
