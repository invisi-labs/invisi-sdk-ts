import { describe, it, expect, vi } from "vitest"

const generateProof = vi.fn(async () => ({ proof: new Uint8Array([0xaa, 0xbb]) }))
const destroy = vi.fn(async () => {})

vi.mock("@aztec/bb.js", () => ({
  Barretenberg: { new: async () => ({ destroy }) },
  UltraHonkBackend: class {
    generateProof = generateProof
  },
}))

import { proveWithWasm } from "./backend-wasm"

describe("proveWithWasm proof flavour", () => {
  it("always proves keccakZK — the deployed solidity verifiers hard-check that length", async () => {
    const hex = await proveWithWasm({
      circuit: { bytecode: "b64", abi: { parameters: [] } } as never,
      witness: new Uint8Array([1]),
    })
    expect(hex).toBe("0xaabb")
    // The second argument is the whole fix: without it bb.js picks a default
    // flavour whose proof no on-chain verifier accepts.
    expect(generateProof).toHaveBeenCalledWith(expect.anything(), { keccakZK: true })
    expect(destroy).toHaveBeenCalled()
  })
})
