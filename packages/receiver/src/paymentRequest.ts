import { deriveNullifierKey, computeIdentityCommitment } from "@invisi-labs/core"
import { chainIdToCAIP2 } from "@invisi-labs/ipp"
import type { IPPRequest, IPPPayloadV1, PaymentType } from "@invisi-labs/ipp"

export interface CreatePaymentRequestParams {
  masterKey: bigint
  invoiceId: bigint
  receivingAddress: bigint
  tokenAddress: `0x${string}`
  chainId: bigint
  operator: `0x${string}`
  paymentTypes: PaymentType[]
  /** 收款单模式：'single' = 金额固定、单次有效 (1a)；'multi' = 多人多次 (1b/2)。SPEC-029 §1 */
  mode: "single" | "multi"
  amount?: bigint | undefined
  endpoint?: string | undefined
  meta?: Record<string, string> | undefined
}

export async function createPaymentRequest(
  params: CreatePaymentRequestParams,
): Promise<IPPRequest> {
  const nullifierKey = await deriveNullifierKey(params.masterKey, params.invoiceId)
  const identityCommitment = await computeIdentityCommitment(
    nullifierKey,
    params.receivingAddress,
  )

  // SPEC-029: payload carries no payment materials (nonce / paymentCommitment / treeId).
  // All materials are delivered via propose; the scan request only declares mode.
  const payload: IPPPayloadV1 = {
    identityCommitment,
    tokenAddress: params.tokenAddress,
    operator: params.operator,
    paymentTypes: params.paymentTypes,
    mode: params.mode,
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

  return request
}
