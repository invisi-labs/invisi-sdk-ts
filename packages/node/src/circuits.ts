import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { CIRCUIT_NAMES, type CircuitName, type CompiledCircuit } from "./circuit-types"

export { CIRCUIT_NAMES }
export type { CircuitName, CompiledCircuit }

const __dirname = dirname(fileURLToPath(import.meta.url))
const circuitsDir = join(__dirname, "..", "circuits")

const cache = new Map<CircuitName, CompiledCircuit>()

export function loadCircuit(name: CircuitName): CompiledCircuit {
  const cached = cache.get(name)
  if (cached) return cached

  if (!(CIRCUIT_NAMES as readonly string[]).includes(name)) {
    throw new Error(`Unknown circuit: ${name}`)
  }

  const filePath = join(circuitsDir, `${name}.json`)
  const raw = readFileSync(filePath, "utf-8")
  const circuit: CompiledCircuit = JSON.parse(raw)
  cache.set(name, circuit)
  return circuit
}

export function getCircuitPath(name: CircuitName): string {
  return join(circuitsDir, `${name}.json`)
}
