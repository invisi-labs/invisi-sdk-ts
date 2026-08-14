import { FIELD_MODULUS } from "./random"

/**
 * Reduces a big-endian-decoded 32-byte secret into the BN254 scalar field.
 *
 * masterKey is keccak256 output — a uniform 256-bit value, so it lands below the
 * modulus only ~19% of the time. The two reference implementations both reduce it
 * at exactly this boundary and declare each other equivalent:
 *   invisi-nexus  pkg/kms/field.go        bytesToField  = SetBytes(b) mod p
 *   invisi-sdk-rust invisi-sdk-core/field.rs bytes_to_field = Fr::from_be_bytes_mod_order
 * Anything other than `mod p` here yields a nullifierKey that disagrees with the
 * server-derived one, and the server rejects the receive request rather than
 * minting a leaf its owner could not withdraw.
 *
 * Takes a bigint rather than bytes because callers hold the key as 0x-hex and
 * BigInt() has already done the big-endian decode that Go/Rust do inline.
 */
export function bytesToField(value: bigint): bigint {
  // Negative input cannot come from decoding bytes, so it means the caller
  // passed something that is not a key. JS `%` would return a negative value
  // and hand poseidonHash an input its range check rejects with a confusing
  // message; fail here, where the actual mistake is.
  if (value < 0n) {
    throw new RangeError(`bytesToField: expected a non-negative value, got ${value}`)
  }
  return value % FIELD_MODULUS
}
