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
})
