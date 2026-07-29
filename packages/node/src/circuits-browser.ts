import { CIRCUIT_NAMES, type CircuitName, type CompiledCircuit } from "./circuit-types"

export { CIRCUIT_NAMES }
export type { CircuitName, CompiledCircuit }

// Static import map so a consuming bundler (Vite/webpack/esbuild) can resolve and
// code-split each circuit chunk. No node:fs — the JSON is a bundled asset.
const loaders: Record<CircuitName, () => Promise<{ default: unknown }>> = {
  batch_settle_1: () => import("../circuits/batch_settle_1.json"),
  batch_settle_3: () => import("../circuits/batch_settle_3.json"),
  batch_settle_10: () => import("../circuits/batch_settle_10.json"),
  batch_settle_100: () => import("../circuits/batch_settle_100.json"),
  shielded_payment: () => import("../circuits/shielded_payment.json"),
  credit_draw_1: () => import("../circuits/credit_draw_1.json"),
  credit_draw_3: () => import("../circuits/credit_draw_3.json"),
  credit_draw_10: () => import("../circuits/credit_draw_10.json"),
  credit_draw_100: () => import("../circuits/credit_draw_100.json"),
  credit_reclaim: () => import("../circuits/credit_reclaim.json"),
}

const cache = new Map<CircuitName, CompiledCircuit>()

export async function loadCircuitBrowser(name: CircuitName): Promise<CompiledCircuit> {
  const cached = cache.get(name)
  if (cached) return cached

  const loader = loaders[name]
  if (!loader) throw new Error(`Unknown circuit: ${name}`)

  const mod = await loader()
  const circuit = ((mod as { default?: unknown }).default ?? mod) as CompiledCircuit
  cache.set(name, circuit)
  return circuit
}
