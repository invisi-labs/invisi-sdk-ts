import type { CompiledCircuit } from "./circuits"

export async function proveWithWasm(params: {
  circuit: CompiledCircuit
  witness: Uint8Array
}): Promise<`0x${string}`> {
  const { Barretenberg, UltraHonkBackend } = await import("@aztec/bb.js")

  const api = await Barretenberg.new()
  try {
    const backend = new UltraHonkBackend(params.circuit.bytecode, api)
    const proofData = await backend.generateProof(params.witness)
    const proofHex = Buffer.from(proofData.proof).toString("hex")
    return `0x${proofHex}` as `0x${string}`
  } finally {
    await api.destroy()
  }
}
