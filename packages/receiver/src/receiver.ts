import { encodeFunctionData } from "viem"
import { deriveClaimingKey, computeReceiverCommitment, computeNullifier } from "@invisi/core"
import { invisiPoolAbi } from "@invisi/contracts"

export interface GenerateInvoiceParams { masterKey: bigint; invoiceId: bigint; receivingAddress: bigint; tokenAddress: `0x${string}`; amount: bigint; treeId: bigint }
export interface Invoice { invoiceId: bigint; claimingKey: bigint; receiverCommitment: `0x${string}`; receivingAddress: bigint; tokenAddress: `0x${string}`; amount: bigint; treeId: bigint }

export interface SettleSingleParams {
  claimingKey: bigint
  amount: bigint
  nonce: bigint
  receivingAddress: `0x${string}`
  tokenAddress: `0x${string}`
  merkleRoot: `0x${string}`
  proof: `0x${string}`
  treeId: bigint
}
export interface SettleSingleCalldata { nullifier: `0x${string}`; data: `0x${string}` }

export async function generateInvoice(params: GenerateInvoiceParams): Promise<Invoice> {
  const claimingKey = await deriveClaimingKey(params.masterKey, params.invoiceId)
  const receiverCommitment = await computeReceiverCommitment(claimingKey, params.receivingAddress)
  return { invoiceId: params.invoiceId, claimingKey, receiverCommitment, receivingAddress: params.receivingAddress, tokenAddress: params.tokenAddress, amount: params.amount, treeId: params.treeId }
}

export async function buildSettleSingleCalldata(
  params: SettleSingleParams
): Promise<SettleSingleCalldata> {
  const nullifier = await computeNullifier(params.claimingKey, BigInt(params.tokenAddress), params.amount, params.nonce)
  const data = encodeFunctionData({
    abi: invisiPoolAbi,
    functionName: "settleSingle",
    args: [
      params.proof,
      params.merkleRoot,
      nullifier as `0x${string}`,
      params.receivingAddress,
      params.tokenAddress,
      params.amount,
      params.treeId,
    ],
  })
  return { nullifier: nullifier as `0x${string}`, data }
}
