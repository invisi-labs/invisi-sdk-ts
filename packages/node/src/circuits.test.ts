import { describe, it, expect } from "vitest"
import { loadCircuit, CIRCUIT_NAMES, type CircuitName } from "./circuits"

describe("loadCircuit", () => {
  it("loads batch_settle_1 and returns a valid CompiledCircuit shape", () => {
    const circuit = loadCircuit("batch_settle_1")
    expect(circuit).toHaveProperty("abi")
    expect(circuit).toHaveProperty("bytecode")
    expect(circuit.abi.parameters.length).toBeGreaterThan(0)
  })

  it("throws on unknown circuit name", () => {
    expect(() => loadCircuit("nonexistent" as CircuitName)).toThrow()
  })

  it.each(CIRCUIT_NAMES)("loads %s successfully", (name) => {
    const circuit = loadCircuit(name)
    expect(circuit).toHaveProperty("bytecode")
    expect(typeof circuit.bytecode).toBe("string")
  })
})
