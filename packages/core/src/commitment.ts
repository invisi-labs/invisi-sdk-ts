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

/**
 * changeCommitment = Poseidon2(Poseidon2(changeClaimingKey, changeReceivingAddress), tokenAddress, amount, nonce)
 *
 * Structurally identical to paymentCommitment, but claimingKey belongs to the payer.
 * changeReceivingAddress is the payer's designated change receiving address.
 */
export async function computeChangeCommitment(
  changeClaimingKey: bigint,
  changeReceivingAddress: bigint,
  tokenAddress: bigint,
  amount: bigint,
  nonce: bigint
): Promise<`0x${string}`> {
  const changeReceiverCommitment = await poseidonHash([changeClaimingKey, changeReceivingAddress])
  return poseidonHash([BigInt(changeReceiverCommitment), tokenAddress, amount, nonce])
}
