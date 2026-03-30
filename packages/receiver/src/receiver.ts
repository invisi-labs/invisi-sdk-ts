import { encodeFunctionData } from "viem"
import { deriveNullifierKey, computeIdentityCommitment } from "@invisi/core"
import { invisiProtocolAbi } from "@invisi/contracts"

export interface GenerateInvoiceParams { masterKey: bigint; invoiceId: bigint; receivingAddress: bigint; tokenAddress: `0x${string}`; amount: bigint; treeId: bigint }
export interface Invoice { invoiceId: bigint; nullifierKey: bigint; identityCommitment: `0x${string}`; receivingAddress: bigint; tokenAddress: `0x${string}`; amount: bigint; treeId: bigint }

export interface BatchCircuitInfo {
  name: string
  maxSize: number
}

export interface WithdrawParams {
  nullifiers: `0x${string}`[]
  totalAmount: bigint
  receivingAddress: `0x${string}`
  tokenAddress: `0x${string}`
  merkleRoot: `0x${string}`
  proof: `0x${string}`
  treeId: bigint
}

export interface WithdrawCalldata {
  data: `0x${string}`
  nullifiers: `0x${string}`[]
  totalAmount: bigint
}

export async function generateInvoice(params: GenerateInvoiceParams): Promise<Invoice> {
  const nullifierKey = await deriveNullifierKey(params.masterKey, params.invoiceId)
  const identityCommitment = await computeIdentityCommitment(nullifierKey, params.receivingAddress)
  return { invoiceId: params.invoiceId, nullifierKey, identityCommitment, receivingAddress: params.receivingAddress, tokenAddress: params.tokenAddress, amount: params.amount, treeId: params.treeId }
}

export function selectBatchCircuit(count: number): BatchCircuitInfo {
  if (count < 1 || count > 100) throw new Error("invalid batch size")
  if (count === 1) return { name: "batch_settle_1", maxSize: 1 }
  if (count <= 3) return { name: "batch_settle_3", maxSize: 3 }
  if (count <= 10) return { name: "batch_settle_10", maxSize: 10 }
  return { name: "batch_settle_100", maxSize: 100 }
}

export async function buildWithdrawCalldata(params: WithdrawParams): Promise<WithdrawCalldata> {
  const data = encodeFunctionData({
    abi: invisiProtocolAbi,
    functionName: "withdraw",
    args: [
      params.proof,
      params.merkleRoot,
      params.nullifiers,
      params.totalAmount,
      params.receivingAddress,
      params.tokenAddress,
      params.treeId,
    ],
  })

  return {
    data,
    nullifiers: params.nullifiers,
    totalAmount: params.totalAmount,
  }
}
