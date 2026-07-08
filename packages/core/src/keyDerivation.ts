import { poseidonHash } from "./poseidon"
import { D_NKEY, D_CREDIT_NKEY } from "./domains"

export async function deriveNullifierKey(masterKey: bigint, invoiceId: bigint): Promise<bigint> {
  const hash = await poseidonHash([D_NKEY, masterKey, invoiceId])
  return BigInt(hash)
}

/**
 * Derives the credit shared secret from the receiver's master key.
 * Domain-separated from deriveNullifierKey (D_CREDIT_NKEY vs D_NKEY) so holding
 * this key reveals neither receiverNullifierKey nor receiverMasterKey.
 */
export async function deriveCreditNullifierKey(receiverMasterKey: bigint, creditId: bigint): Promise<bigint> {
  const hash = await poseidonHash([D_CREDIT_NKEY, receiverMasterKey, creditId])
  return BigInt(hash)
}
