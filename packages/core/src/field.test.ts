import { describe, it, expect } from "vitest"
import { bytesToField } from "./field"
import { FIELD_MODULUS } from "./random"

describe("bytesToField", () => {
  it("leaves a value already below the modulus untouched", () => {
    expect(bytesToField(111n)).toBe(111n)
    expect(bytesToField(FIELD_MODULUS - 1n)).toBe(FIELD_MODULUS - 1n)
  })

  it("reduces the modulus itself to zero", () => {
    expect(bytesToField(FIELD_MODULUS)).toBe(0n)
  })

  it("reduces a full-width 256-bit value into the field", () => {
    // 0xff…ff — what ~81% of keccak256 masterKeys look like as far as the field
    // is concerned: representable in 32 bytes, but above the modulus.
    const max256 = (1n << 256n) - 1n
    const reduced = bytesToField(max256)
    expect(reduced).toBe(max256 % FIELD_MODULUS)
    expect(reduced).toBeLessThan(FIELD_MODULUS)
  })

  it("rejects a negative value instead of returning a negative remainder", () => {
    expect(() => bytesToField(-1n)).toThrow(RangeError)
  })
})
