import { describe, it, expect } from "vitest"
import { deriveNullifierKey } from "./keyDerivation"

describe("deriveNullifierKey", () => {
  it("returns a bigint", async () => {
    const result = await deriveNullifierKey(111n, 222n)
    expect(typeof result).toBe("bigint")
  })

  it("is deterministic", async () => {
    const a = await deriveNullifierKey(111n, 222n)
    const b = await deriveNullifierKey(111n, 222n)
    expect(a).toBe(b)
  })

  it("different inputs produce different outputs", async () => {
    const a = await deriveNullifierKey(111n, 1n)
    const b = await deriveNullifierKey(111n, 2n)
    expect(a).not.toBe(b)
  })
})

describe("SPEC-026: deprecated alias removed", () => {
  it("does not export deriveClaimingKey from the core entrypoint", async () => {
    const mod = await import("./index")
    expect("deriveClaimingKey" in mod).toBe(false)
  })
})
