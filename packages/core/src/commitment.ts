import { poseidonHash } from "./poseidon"

export async function computeReceiverCommitment(claimingKey: bigint): Promise<`0x${string}`> {
  return poseidonHash([claimingKey])
}

export async function computePaymentCommitment(claimingKey: bigint, amount: bigint): Promise<`0x${string}`> {
  const rc = await computeReceiverCommitment(claimingKey)
  return poseidonHash([BigInt(rc), amount])
}
