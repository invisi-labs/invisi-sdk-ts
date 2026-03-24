import { poseidonHash } from "./poseidon"
import { D_NKEY } from "./domains"

export async function deriveNullifierKey(masterKey: bigint, invoiceId: bigint): Promise<bigint> {
  const hash = await poseidonHash([D_NKEY, masterKey, invoiceId])
  return BigInt(hash)
}

/** @deprecated Use deriveNullifierKey */
export const deriveClaimingKey = deriveNullifierKey
