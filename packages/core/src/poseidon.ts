import { Barretenberg, Fr } from "@aztec/bb.js"

let bb: Barretenberg | null = null

async function getBB(): Promise<Barretenberg> {
  if (!bb) {
    bb = await Barretenberg.new({ threads: 1 })
  }
  return bb
}

export async function poseidonHash(inputs: bigint[]): Promise<`0x${string}`> {
  const instance = await getBB()
  const frs = inputs.map((n) => new Fr(n))
  const result = await instance.poseidon2Hash(frs)
  return result.toString() as `0x${string}`
}
