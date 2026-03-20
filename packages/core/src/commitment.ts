import { poseidonHash } from "./poseidon"

/** receiverCommitment = Poseidon2(claimingKey, receivingAddress) */
export async function computeReceiverCommitment(
  claimingKey: bigint,
  receivingAddress: bigint
): Promise<`0x${string}`> {
  return poseidonHash([claimingKey, receivingAddress])
}

/**
 * paymentCommitment = Poseidon2(receiverCommitment, tokenAddress, amount, nonce)
 */
export async function computePaymentCommitment(
  receiverCommitment: `0x${string}`,
  tokenAddress: bigint,
  amount: bigint,
  nonce: bigint
): Promise<`0x${string}`> {
  return poseidonHash([BigInt(receiverCommitment), tokenAddress, amount, nonce])
}
