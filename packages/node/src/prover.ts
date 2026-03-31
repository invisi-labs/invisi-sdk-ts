import { loadCircuit, getCircuitPath, type CircuitName } from "./circuits"
import { generateWitness } from "./witness"
import { proveWithBB } from "./backend-bb"
import { proveWithWasm } from "./backend-wasm"

export type Backend = "bb" | "wasm"

export interface ProveParams {
  circuitName: CircuitName
  inputs: Record<string, unknown>
  backend?: Backend
  bbBin?: string
}

export async function generateProof(params: ProveParams): Promise<`0x${string}`> {
  const circuit = loadCircuit(params.circuitName)
  const witness = await generateWitness(circuit, params.inputs)
  const backend = params.backend ?? "bb"

  if (backend === "bb") {
    return proveWithBB({
      acirPath: getCircuitPath(params.circuitName),
      witness,
      ...(params.bbBin !== undefined ? { bbBin: params.bbBin } : {}),
    })
  } else {
    return proveWithWasm({ circuit, witness })
  }
}
