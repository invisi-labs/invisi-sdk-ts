import { poseidonHash } from "./poseidon"

export async function computeNullifier(claimingKey: bigint, amount: bigint): Promise<`0x${string}`> {
  return poseidonHash([claimingKey, amount])
}
