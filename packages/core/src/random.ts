declare const crypto: { getRandomValues<T extends ArrayBufferView>(array: T): T }

/** BN254 scalar field modulus */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

/** Generate a random nonce in the BN254 scalar field */
export function generateNonce(): bigint {
  const buf = new Uint8Array(32)
  crypto.getRandomValues(buf)
  const raw = BigInt("0x" + Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(""))
  return raw % FIELD_MODULUS
}
