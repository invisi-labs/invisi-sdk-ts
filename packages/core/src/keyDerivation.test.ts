import { describe, it, expect } from "vitest"
import { deriveClaimingKey } from "./keyDerivation"

describe("deriveClaimingKey", () => {
  it("returns a bigint", async () => {
    const result = await deriveClaimingKey(111n, 222n)
    expect(typeof result).toBe("bigint")
  })

  it("is deterministic", async () => {
    const a = await deriveClaimingKey(111n, 222n)
    const b = await deriveClaimingKey(111n, 222n)
    expect(a).toBe(b)
  })

  it("different inputs produce different outputs", async () => {
    const a = await deriveClaimingKey(111n, 1n)
    const b = await deriveClaimingKey(111n, 2n)
    expect(a).not.toBe(b)
  })
})
