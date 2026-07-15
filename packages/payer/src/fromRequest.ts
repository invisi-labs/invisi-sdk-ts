import { caip2ToChainId } from "@invisi-labs/ipp"
import type { IPPRequest } from "@invisi-labs/ipp"
import { verifyPaymentCommitment } from "./verify"
import { buildPayOpenCalldata } from "./payer"

export interface BuildPaymentFromRequestParams {
  request: IPPRequest
  nonce: `0x${string}`
  paymentCommitment: `0x${string}`
  amount: bigint
  /** Sourced from the propose response's treeId. */
  treeId: bigint
}

export interface BuildPaymentFromRequestResult {
  calldata: `0x${string}`
  approveAmount: bigint
}

export async function buildPaymentFromRequest(
  params: BuildPaymentFromRequestParams,
): Promise<BuildPaymentFromRequestResult> {
  const chainId = caip2ToChainId(params.request.network)
  const p = params.request.payload

  const valid = await verifyPaymentCommitment({
    identityCommitment: p.identityCommitment as `0x${string}`,
    tokenAddress: p.tokenAddress as `0x${string}`,
    amount: params.amount,
    nonce: params.nonce,
    paymentCommitment: params.paymentCommitment,
    chainId,
  })

  if (!valid) {
    throw new Error(
      "paymentCommitment verification failed: server returned incorrect parameters",
    )
  }

  const result = await buildPayOpenCalldata({
    chainId,
    identityCommitment: p.identityCommitment as `0x${string}`,
    tokenAddress: p.tokenAddress as `0x${string}`,
    amount: params.amount,
    treeId: params.treeId,
    nonce: BigInt(params.nonce),
  })

  return {
    calldata: result.data,
    approveAmount: result.approveAmount,
  }
}
