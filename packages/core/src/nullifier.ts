import { poseidonHash } from "./poseidon"

/** nullifier = Poseidon2(claimingKey, tokenAddress, amount, nonce) */
export async function computeNullifier(
  claimingKey: bigint,
  tokenAddress: bigint,
  amount: bigint,
  nonce: bigint
): Promise<`0x${string}`> {
  return poseidonHash([claimingKey, tokenAddress, amount, nonce])
}
