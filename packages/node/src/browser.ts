import { loadCircuitBrowser } from "./circuits-browser"
import { generateWitness } from "./witness"
import { proveWithWasm } from "./backend-wasm"
import type { CircuitName } from "./circuit-types"

export interface ProveBrowserParams {
  circuitName: CircuitName
  inputs: Record<string, unknown>
}

// Browser-safe proof generation: loads the circuit via a bundler-resolved asset
// (no node:fs), builds the witness in-browser, and proves with the bb.js WASM
// backend. Output is byte-identical to the node WASM path for a given (circuit, witness).
export async function generateProof(params: ProveBrowserParams): Promise<`0x${string}`> {
  const circuit = await loadCircuitBrowser(params.circuitName)
  const witness = await generateWitness(circuit, params.inputs)
  return proveWithWasm({ circuit, witness })
}

export { loadCircuitBrowser } from "./circuits-browser"
export { generateWitness } from "./witness"
export { proveWithWasm } from "./backend-wasm"
export { CIRCUIT_NAMES } from "./circuit-types"
export type { CircuitName, CompiledCircuit } from "./circuit-types"
