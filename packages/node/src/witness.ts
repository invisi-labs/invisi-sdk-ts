import { Noir } from "@noir-lang/noir_js"
import type { CompiledCircuit } from "./circuits"

export async function generateWitness(
  circuit: CompiledCircuit,
  inputs: Record<string, unknown>,
): Promise<Uint8Array> {
  const noir = new Noir(circuit as any)
  const { witness } = await noir.execute(inputs as any)
  return witness
}
