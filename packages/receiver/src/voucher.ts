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
 */
export async function verifyVoucher(params: VerifyVoucherParams): Promise<boolean> {
  const p = params.voucher.payload
  const chainId = params.chainId ?? caip2ToChainId(params.voucher.network)

  // Check 1: identityCommitment must bind the nullifierKey to this receiver's address
  const ic = await computeIdentityCommitment(BigInt(p.nullifierKey), params.receivingAddress)
  if (ic.toLowerCase() !== p.identityCommitment.toLowerCase()) return false

  // Check 2: paymentCommitment must be internally consistent
  const pc = await computePaymentCommitment(
    chainId,
    p.identityCommitment as `0x${string}`,
    BigInt(p.tokenAddress),
    BigInt(p.amount),
    BigInt(p.nonce),
  )
  return pc.toLowerCase() === p.paymentCommitment.toLowerCase()
}

/**
 * Build the withdraw request body from a voucher. nullifierKey stays client-side
 * (used for local proof generation), never sent to the endpoint.
 */
export function voucherToWithdrawRequest(voucher: IPPVoucher): WithdrawRequest {
  const p = voucher.payload
  return {
    identityCommitment: p.identityCommitment,
    tokenAddress: p.tokenAddress,
    treeId: p.treeId,
    paymentCommitments: [p.paymentCommitment],
  }
}
