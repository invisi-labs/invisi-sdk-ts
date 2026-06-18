import { deriveNullifierKey, computeIdentityCommitment } from "@invisi-labs/core"
import { chainIdToCAIP2 } from "@invisi-labs/ipp"
import type { IPPRequest, IPPPayloadV1, PaymentType } from "@invisi-labs/ipp"
import { computePaymentCommitmentForPropose } from "./propose"

export interface CreatePaymentRequestParams {
  masterKey: bigint
  invoiceId: bigint
  receivingAddress: bigint
  tokenAddress: `0x${string}`
  chainId: bigint
  treeId: bigint
  operator: `0x${string}`
  paymentTypes: PaymentType[]
  amount?: bigint | undefined
  endpoint?: string | undefined
  meta?: Record<string, string> | undefined
  /** true = 多人扫码模式（不生成 nonce，由 propose 分配） */
  multiPayer?: boolean | undefined
}

export async function createPaymentRequest(
  params: CreatePaymentRequestParams,
): Promise<IPPRequest> {
  const nullifierKey = await deriveNullifierKey(params.masterKey, params.invoiceId)
  const identityCommitment = await computeIdentityCommitment(
    nullifierKey,
    params.receivingAddress,
  )

  const payload: IPPPayloadV1 = {
    identityCommitment,
    tokenAddress: params.tokenAddress,
    operator: params.operator,
    treeId: params.treeId.toString(),
    paymentTypes: params.paymentTypes,
  }

  const request: IPPRequest = {
    v: 1,
    network: chainIdToCAIP2(params.chainId),
    type: "request",
    payload,
  }

  if (params.amount !== undefined) {
    request.payload.amount = params.amount.toString()
  }

  if (params.endpoint !== undefined) {
    request.payload.endpoint = params.endpoint
  }

  if (params.meta !== undefined) {
    request.meta = params.meta
  }

  // 模式 1a：有 amount、无 multiPayer → 预算 nonce + paymentCommitment
  if (params.amount !== undefined && !params.multiPayer) {
    const { nonce, paymentCommitment } = await computePaymentCommitmentForPropose({
      identityCommitment,
      tokenAddress: params.tokenAddress,
      amount: params.amount,
      chainId: params.chainId,
    })
    request.payload.nonce = nonce
    request.payload.paymentCommitment = paymentCommitment
  }

  return request
}
