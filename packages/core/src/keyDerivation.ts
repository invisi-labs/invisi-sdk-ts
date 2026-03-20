import { poseidonHash } from "./poseidon"

export async function deriveClaimingKey(masterKey: bigint, invoiceId: bigint): Promise<bigint> {
  const hash = await poseidonHash([masterKey, invoiceId])
  return BigInt(hash)
}
