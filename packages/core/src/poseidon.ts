import { Barretenberg, BackendType } from "@aztec/bb.js"
import { FIELD_MODULUS } from "./random"

let bbPromise: Promise<Barretenberg> | null = null

function getBB(): Promise<Barretenberg> {
  if (!bbPromise) {
    bbPromise = Barretenberg.new({ threads: 1, backend: BackendType.Wasm })
  }
  return bbPromise
}

function bigintToBytes32(n: bigint): Uint8Array {
  const buf = new Uint8Array(32)
  for (let i = 31; i >= 0 && n > 0n; i--) {
    buf[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return buf
}

function bytes32ToHex(buf: Uint8Array): `0x${string}` {
  return `0x${[...buf].map((b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`
}

export async function poseidonHash(inputs: bigint[]): Promise<`0x${string}`> {
  // Every input must be a canonical BN254 field element. bigintToBytes32 keeps
  // only the low 32 bytes and ignores the sign, so a negative or >= modulus
  // value would be silently folded into the field and hash to a value that
  // disagrees with the in-circuit Poseidon over the same nominal input. Reject
  // at the entry so the caller sees the range violation here rather than as an
  // unsatisfiable proof much further downstream. The modulus bound also rejects
  // any value wider than 32 bytes, since it is necessarily >= FIELD_MODULUS.
  for (let i = 0; i < inputs.length; i++) {
    const n = inputs[i]!
    if (n < 0n || n >= FIELD_MODULUS) {
      throw new RangeError(
        `poseidonHash: input[${i}] out of BN254 field range [0, FIELD_MODULUS): ${n}`,
      )
    }
  }
  const instance = await getBB()
  const frs = inputs.map(bigintToBytes32)
  const { hash } = await instance.poseidon2Hash({ inputs: frs })
  return bytes32ToHex(hash)
}
