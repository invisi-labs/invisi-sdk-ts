import type { IPPVoucher } from "@invisi-labs/ipp"

export interface BuildVoucherParams {
  network: string
  receivingAddress: string
  paymentCommitment: string
  tokenAddress: string
  operator: string
  amount: bigint
  nonce: string
  nullifierKey: string
  treeId: string
  leafIndex?: string | undefined
  meta?: Record<string, string> | undefined
}

/**
 * Assemble a payment voucher (mode 3 address transfer) from values the payer
 * already holds after payOpen. Pure local assembly — no chain / endpoint call.
 */
export function buildVoucher(params: BuildVoucherParams): IPPVoucher {
  return {
    v: 1,
    network: params.network,
    type: "voucher",
    ...(params.meta ? { meta: params.meta } : {}),
    payload: {
      receivingAddress: params.receivingAddress,
      paymentCommitment: params.paymentCommitment,
      tokenAddress: params.tokenAddress,
      operator: params.operator,
      amount: params.amount.toString(),
      nonce: params.nonce,
      nullifierKey: params.nullifierKey,
      treeId: params.treeId,
      ...(params.leafIndex ? { leafIndex: params.leafIndex } : {}),
    },
  }
}
