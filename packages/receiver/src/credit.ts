import { encodeFunctionData } from "viem"
import { invisiProtocolAbi } from "@invisi/contracts"

export interface CreditRecord {
  creditId: string
  commitment: `0x${string}`
  payerCommitment: `0x${string}`
  creditNullifierKey: bigint
  tokenAddress: `0x${string}`
  amount: bigint
  nonce: bigint
  expiry: bigint
  treeId: bigint
  leafIndex: number
  status: 'active' | 'exhausted' | 'expired'
}

export interface CreditDrawCalldata {
  data: `0x${string}`
  nullifiers: `0x${string}`[]
  totalAmount: bigint
}

export function selectCreditDrawCircuit(count: number): { name: string; maxSize: number } {
  if (count < 1 || count > 100) throw new Error("invalid credit draw batch size")
  if (count === 1) return { name: "credit_draw_1", maxSize: 1 }
  if (count <= 3) return { name: "credit_draw_3", maxSize: 3 }
  if (count <= 10) return { name: "credit_draw_10", maxSize: 10 }
  return { name: "credit_draw_100", maxSize: 100 }
}

export interface BuildCreditDrawCalldataParams {
  nullifiers: `0x${string}`[]
  totalAmount: bigint
  receivingAddress: `0x${string}`
  tokenAddress: `0x${string}`
  merkleRoot: `0x${string}`
  proof: `0x${string}`
  treeId: bigint
  remainderCommitments: `0x${string}`[]
  expiry: bigint
}

export async function buildCreditDrawCalldata(params: BuildCreditDrawCalldataParams): Promise<CreditDrawCalldata> {
  const data = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "creditDraw",
    args: [
      params.proof,
      {
        merkleRoot: params.merkleRoot,
        nullifiers: params.nullifiers,
        totalAmount: params.totalAmount,
        receivingAddress: params.receivingAddress,
        tokenAddress: params.tokenAddress,
        treeId: params.treeId,
        remainderCommitments: params.remainderCommitments,
        expiry: params.expiry,
      },
    ],
  })

  return { data, nullifiers: params.nullifiers, totalAmount: params.totalAmount }
}
