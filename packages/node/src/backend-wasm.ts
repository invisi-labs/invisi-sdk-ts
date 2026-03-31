import type { CompiledCircuit } from "./circuits"

export async function proveWithWasm(params: {
  circuit: CompiledCircuit
  witness: Uint8Array
}): Promise<`0x${string}`> {
  const { UltraHonkBackend } = await import("@aztec/bb.js")

  const backend = new UltraHonkBackend(params.circuit.bytecode)
  try {
    const proofData = await backend.generateProof(params.witness)
    const proofHex = Buffer.from(proofData.proof).toString("hex")
    return `0x${proofHex}` as `0x${string}`
  } finally {
    await backend.destroy()
  }
}
