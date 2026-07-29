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
