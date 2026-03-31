import { caip2ToChainId } from "@invisi/ipp"
import type { IPPRequest } from "@invisi/ipp"
import { verifyPaymentCommitment } from "./verify"
import { buildPayOpenCalldata } from "./payer"

export interface BuildPaymentFromRequestParams {
  request: IPPRequest
  nonce: `0x${string}`
  paymentCommitment: `0x${string}`
  amount: bigint
}

export interface BuildPaymentFromRequestResult {
  calldata: `0x${string}`
  approveAmount: bigint
}

export async function buildPaymentFromRequest(
  params: BuildPaymentFromRequestParams,
): Promise<BuildPaymentFromRequestResult> {
  const chainId = caip2ToChainId(params.request.network)

  const valid = await verifyPaymentCommitment({
    identityCommitment: params.request.identityCommitment as `0x${string}`,
    tokenAddress: params.request.tokenAddress as `0x${string}`,
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

  // 传入外部 nonce，确保 calldata 使用 propose 分配的 nonce
  const result = await buildPayOpenCalldata({
    chainId,
    identityCommitment: params.request.identityCommitment as `0x${string}`,
    tokenAddress: params.request.tokenAddress as `0x${string}`,
    amount: params.amount,
    treeId: BigInt(params.request.treeId),
    nonce: BigInt(params.nonce),
  })

  return {
    calldata: result.data,
    approveAmount: result.approveAmount,
  }
}
