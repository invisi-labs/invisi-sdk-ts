import { computePaymentCommitment } from "@invisi-labs/core"

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
