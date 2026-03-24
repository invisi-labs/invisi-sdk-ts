import { describe, it, expect } from "vitest"
import { computePaymentNullifier } from "./nullifier"

const CHAIN_ID = 1n

describe("computePaymentNullifier", () => {
  it("returns a valid hex string", async () => {
    const result = await computePaymentNullifier(CHAIN_ID, 42n, 0xbeefn, 1000n, 12345n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("is deterministic", async () => {
    const a = await computePaymentNullifier(CHAIN_ID, 42n, 0xbeefn, 1000n, 12345n)
    const b = await computePaymentNullifier(CHAIN_ID, 42n, 0xbeefn, 1000n, 12345n)
    expect(a).toBe(b)
  })

  it("different nonces produce different nullifiers", async () => {
    const a = await computePaymentNullifier(CHAIN_ID, 42n, 0xbeefn, 1000n, 1n)
    const b = await computePaymentNullifier(CHAIN_ID, 42n, 0xbeefn, 1000n, 2n)
    expect(a).not.toBe(b)
  })

  it("different tokens produce different nullifiers", async () => {
    const a = await computePaymentNullifier(CHAIN_ID, 42n, 0xbeefn, 1000n, 1n)
    const b = await computePaymentNullifier(CHAIN_ID, 42n, 0xcafen, 1000n, 1n)
    expect(a).not.toBe(b)
  })

  it("different chain IDs produce different nullifiers", async () => {
    const a = await computePaymentNullifier(1n, 42n, 0xbeefn, 1000n, 1n)
    const b = await computePaymentNullifier(2n, 42n, 0xbeefn, 1000n, 1n)
    expect(a).not.toBe(b)
  })

  it("different nullifier keys produce different nullifiers", async () => {
    const a = await computePaymentNullifier(CHAIN_ID, 42n, 0xbeefn, 1000n, 1n)
    const b = await computePaymentNullifier(CHAIN_ID, 43n, 0xbeefn, 1000n, 1n)
    expect(a).not.toBe(b)
  })
})
