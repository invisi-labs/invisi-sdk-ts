import { describe, it, expect } from "vitest"
import { computeNullifier } from "./nullifier"
import { poseidonHash } from "./poseidon"

describe("computeNullifier", () => {
  it("returns a 32-byte hex string", async () => {
    const result = await computeNullifier(42n, 0xbeefn, 1000n, 12345n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("equals poseidon([claimingKey, tokenAddress, amount, nonce])", async () => {
    const expected = await poseidonHash([42n, 0xbeefn, 1000n, 12345n])
    const result = await computeNullifier(42n, 0xbeefn, 1000n, 12345n)
    expect(result).toBe(expected)
  })

  it("different nonces produce different nullifiers", async () => {
    const a = await computeNullifier(42n, 0xbeefn, 1000n, 1n)
    const b = await computeNullifier(42n, 0xbeefn, 1000n, 2n)
    expect(a).not.toBe(b)
  })

  it("different tokens produce different nullifiers", async () => {
    const a = await computeNullifier(42n, 0xbeefn, 1000n, 1n)
    const b = await computeNullifier(42n, 0xcafen, 1000n, 1n)
    expect(a).not.toBe(b)
  })
})
