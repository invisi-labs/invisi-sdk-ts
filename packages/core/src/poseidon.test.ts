import { describe, it, expect } from "vitest"
import { poseidonHash } from "./poseidon"

describe("poseidonHash", () => {
  it("returns a 0x-prefixed 32-byte hex string", async () => {
    const result = await poseidonHash([1n, 2n])
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("is deterministic", async () => {
    const a = await poseidonHash([42n])
    const b = await poseidonHash([42n])
    expect(a).toBe(b)
  })

  it("different inputs produce different outputs", async () => {
    const a = await poseidonHash([1n])
    const b = await poseidonHash([2n])
    expect(a).not.toBe(b)
  })

  it("AUDIT-041: concurrent calls all return the same result (singleton Promise cache)", async () => {
    const inputs = [100n, 200n, 300n]
    // Fire 10 concurrent calls with the same inputs
    const promises = Array.from({ length: 10 }, () => poseidonHash(inputs))
    const results = await Promise.all(promises)

    // All results must be identical
    for (const r of results) {
      expect(r).toBe(results[0])
    }
    expect(results[0]).toMatch(/^0x[0-9a-f]{64}$/i)
  })
})
