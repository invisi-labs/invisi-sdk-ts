import { poseidonHash } from "./poseidon"
import { bytesToField } from "./field"
import { D_NKEY, D_CREDIT_NKEY, D_CHANGE_NKEY } from "./domains"

/**
 * masterKey arrives as a raw 32-byte secret, not as a field element, so it goes
 * through bytesToField here — mirroring nexus DeriveNullifierKey, which calls
 * bytesToField inside the derive function for the same reason. Reducing at the
 * call sites instead would leave every future caller to rediscover that ~81% of
 * keys exceed the modulus.
 */
export async function deriveNullifierKey(masterKey: bigint, invoiceId: bigint): Promise<bigint> {
  const hash = await poseidonHash([D_NKEY, bytesToField(masterKey), invoiceId])
  return BigInt(hash)
}

/**
 * Derives the credit shared secret from the receiver's master key.
 * Domain-separated from deriveNullifierKey (D_CREDIT_NKEY vs D_NKEY) so holding
 * this key reveals neither receiverNullifierKey nor receiverMasterKey.
 */
export async function deriveCreditNullifierKey(receiverMasterKey: bigint, creditId: bigint): Promise<bigint> {
  const hash = await poseidonHash([D_CREDIT_NKEY, bytesToField(receiverMasterKey), creditId])
  return BigInt(hash)
}

/**
 * Derives the change shared secret for a shielded payment. The salt is THIS
 * payment's paymentCommitment — a value the payer necessarily holds and has
 * already re-verified locally, so it self-certifies. Domain-separated from
 * deriveNullifierKey / deriveCreditNullifierKey (D_CHANGE_NKEY vs D_NKEY / D_CREDIT_NKEY)
 * so holding the change key reveals neither the receiver nor the credit key.
 * changeNullifierKey = Poseidon2(D_CHANGE_NKEY, payerMasterKey, paymentCommitment)
 */
export async function deriveChangeNullifierKey(payerMasterKey: bigint, paymentCommitment: bigint): Promise<bigint> {
  const hash = await poseidonHash([D_CHANGE_NKEY, bytesToField(payerMasterKey), paymentCommitment])
  return BigInt(hash)
}
