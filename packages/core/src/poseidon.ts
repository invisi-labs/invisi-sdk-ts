import { Barretenberg, BackendType } from "@aztec/bb.js"

let bb: Barretenberg | null = null

async function getBB(): Promise<Barretenberg> {
  if (!bb) {
    bb = await Barretenberg.new({ threads: 1, backend: BackendType.Wasm })
  }
  return bb
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
  const instance = await getBB()
  const frs = inputs.map(bigintToBytes32)
  const { hash } = await instance.poseidon2Hash({ inputs: frs })
  return bytes32ToHex(hash)
}
