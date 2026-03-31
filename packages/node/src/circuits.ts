import { readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const circuitsDir = join(__dirname, "..", "circuits")

export const CIRCUIT_NAMES = [
  "batch_settle_1", "batch_settle_3", "batch_settle_10", "batch_settle_100",
  "shielded_payment",
  "credit_draw_1", "credit_draw_3", "credit_draw_10", "credit_draw_100",
  "credit_reclaim",
] as const

export type CircuitName = (typeof CIRCUIT_NAMES)[number]

export interface CompiledCircuit {
  noir_version: string
  hash: number
  abi: {
    parameters: Array<{ name: string; type: Record<string, unknown>; visibility: string }>
    return_type: unknown
  }
  bytecode: string
  debug_symbols: unknown
  file_map: Record<string, unknown>
  expression_width: number
}

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
