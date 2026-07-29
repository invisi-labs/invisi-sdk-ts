import { describe, it, expect } from "vitest"
// Imports the browser entry only — this module graph must never pull in node:fs.
import { loadCircuitBrowser, generateProof } from "./browser"

describe("loadCircuitBrowser", () => {
  it("returns a valid CompiledCircuit for batch_settle_1 without node:fs", async () => {
    const circuit = await loadCircuitBrowser("batch_settle_1")
    expect(circuit).toHaveProperty("bytecode")
    expect(typeof circuit.bytecode).toBe("string")
    expect(circuit).toHaveProperty("abi")
    expect(circuit.abi.parameters.length).toBeGreaterThan(0)
  })

  it("returns a valid CompiledCircuit for shielded_payment without node:fs", async () => {
    const circuit = await loadCircuitBrowser("shielded_payment")
    expect(circuit).toHaveProperty("bytecode")
    expect(typeof circuit.bytecode).toBe("string")
    expect(circuit).toHaveProperty("abi")
    expect(circuit.abi.parameters.length).toBeGreaterThan(0)
  })
})

describe("generateProof (browser path)", () => {
  // Full pipeline under node (bb.js WASM runs in node too): browser loader ->
  // in-browser witness gen -> proveWithWasm. Validates the wiring end-to-end;
  // real browser + on-chain verify is the consumer's env step.
  it("generates a 0x proof for batch_settle_1 from valid inputs", async () => {
    const inputs = {
      claiming_keys: ["123"],
      nonces: ["42"],
      amounts: ["1000"],
      leaf_indices: ["0"],
      merkle_paths: [Array(16).fill("0")],
      chain_id: "1",
      merkle_root: "0x2ac880615f616e165e3a8dadca15b45754111108e7e069c9b908d8a938ef5128",
      nullifiers: ["0x103d706be84d179ec8b61d5c25af329aa8e45c47a03156e2dd5ded2f452caf09"],
      receiving_address: "456",
      token_address: "789",
      total_amount: "1000",
      actual_count: "1",
    }

    const proof = await generateProof({ circuitName: "batch_settle_1", inputs })
    expect(proof).toMatch(/^0x[0-9a-f]+$/i)
  }, 120_000)
})
