import { describe, it, expect } from "vitest"
import { generateNonce, FIELD_MODULUS } from "./random"

describe("AUDIT-042: generateNonce", () => {
  it("returns a bigint", () => {
    const nonce = generateNonce()
    expect(typeof nonce).toBe("bigint")
  })

  it("returns a value less than FIELD_MODULUS", () => {
    for (let i = 0; i < 20; i++) {
      const nonce = generateNonce()
      expect(nonce).toBeGreaterThanOrEqual(0n)
      expect(nonce).toBeLessThan(FIELD_MODULUS)
    }
  })

  it("returns different values on successive calls (randomness)", () => {
    const nonces = new Set<bigint>()
    for (let i = 0; i < 10; i++) {
      nonces.add(generateNonce())
    }
    // With 256-bit randomness, 10 calls should produce 10 unique values
    expect(nonces.size).toBe(10)
  })
})
