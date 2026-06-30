import { computeIdentityCommitment, computePaymentCommitment } from "@invisi-labs/core"
import { caip2ToChainId } from "@invisi-labs/ipp"
import type { IPPVoucher, WithdrawRequest } from "@invisi-labs/ipp"

export interface VerifyVoucherParams {
  voucher: IPPVoucher
  receivingAddress: bigint   // the receiver's own address
  chainId?: bigint | undefined  // defaults to parsed from voucher.network
}

/**
 * Receiver-side check before withdraw: confirm the voucher binds funds to the
 * receiver's own address and is internally consistent. MUST pass before withdraw.
 * The voucher carries receivingAddress directly; identityCommitment is recomputed
 * locally from receivingAddress + nullifierKey (one-way hash — not reversible).
 */
export async function verifyVoucher(params: VerifyVoucherParams): Promise<boolean> {
  const p = params.voucher.payload
  const chainId = params.chainId ?? caip2ToChainId(params.voucher.network)

  // Check 1: the voucher's receivingAddress must be this receiver's own address —
  // the settle circuit sends funds there, so a mismatch means funds go elsewhere.
  if (BigInt(p.receivingAddress) !== params.receivingAddress) return false

  // Recompute identityCommitment locally (the voucher no longer carries it).
  const ic = await computeIdentityCommitment(BigInt(p.nullifierKey), BigInt(p.receivingAddress))

  // Check 2: paymentCommitment must be internally consistent
  const pc = await computePaymentCommitment(
    chainId,
    ic,
    BigInt(p.tokenAddress),
    BigInt(p.amount),
    BigInt(p.nonce),
  )
  return pc.toLowerCase() === p.paymentCommitment.toLowerCase()
}

/**
 * Build the withdraw request body from a voucher. identityCommitment is omitted
 * (server-advisory — the server locates leaves by paymentCommitments). receivingAddress
 * and nullifierKey stay client-side for local proof generation, never sent to the endpoint.
 */
export function voucherToWithdrawRequest(voucher: IPPVoucher): WithdrawRequest {
  const p = voucher.payload
  return {
    tokenAddress: p.tokenAddress,
    treeId: p.treeId,
    paymentCommitments: [p.paymentCommitment],
  }
}
