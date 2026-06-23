import { computePaymentCommitment, computeCreditCommitment } from "@invisi-labs/core"

export interface VerifyPaymentCommitmentParams {
  identityCommitment: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  nonce: `0x${string}`
  paymentCommitment: `0x${string}`
  chainId: bigint
}

export async function verifyPaymentCommitment(
  params: VerifyPaymentCommitmentParams,
): Promise<boolean> {
  const expected = await computePaymentCommitment(
    params.chainId,
    params.identityCommitment,
    BigInt(params.tokenAddress),
    params.amount,
    BigInt(params.nonce),
  )
  return expected === params.paymentCommitment
}

export interface VerifyCreditCommitmentParams {
  chainId: bigint
  identityCommitment: `0x${string}`
  payerCommitment: `0x${string}`
  tokenAddress: `0x${string}`
  amount: bigint
  nonce: bigint
  expiry: bigint
  nullifierKeyHash: `0x${string}`
  /** Server-returned value to verify against the locally recomputed commitment. */
  creditCommitment: `0x${string}`
}

/**
 * Recomputes the credit commitment locally and compares it to the
 * server-returned value. A mismatch means the server folded a wrong nonce
 * (or other parameter) — the caller MUST abort and not depositCredit.
 */
export async function verifyCreditCommitment(
  params: VerifyCreditCommitmentParams,
): Promise<boolean> {
  const expected = await computeCreditCommitment(
    params.chainId,
    params.identityCommitment,
    params.payerCommitment,
    BigInt(params.tokenAddress),
    params.amount,
    params.nonce,
    params.expiry,
    params.nullifierKeyHash,
  )
  return expected === params.creditCommitment
}
