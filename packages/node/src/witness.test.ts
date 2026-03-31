import { describe, it, expect } from "vitest"
import { generateWitness } from "./witness"
import { loadCircuit } from "./circuits"

describe("generateWitness", () => {
  it("generates a Uint8Array witness from batch_settle_1 inputs", async () => {
    const circuit = loadCircuit("batch_settle_1")
    // Valid inputs derived from circuits/batch_settle_1/Prover.toml
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

    const witness = await generateWitness(circuit, inputs)
    expect(witness).toBeInstanceOf(Uint8Array)
    expect(witness.length).toBeGreaterThan(0)
  })
})
