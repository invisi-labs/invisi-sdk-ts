import { describe, it, expect } from "vitest"
import { computeIdentityCommitment, computePaymentCommitment, computeChangeCommitment } from "./commitment"

const CHAIN_ID = 1n

describe("computeIdentityCommitment", () => {
  it("returns a valid hex string", async () => {
    const result = await computeIdentityCommitment(42n, 0xdeadn)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("is deterministic", async () => {
    const a = await computeIdentityCommitment(42n, 0xdeadn)
    const b = await computeIdentityCommitment(42n, 0xdeadn)
    expect(a).toBe(b)
  })

  it("different addresses produce different commitments", async () => {
    const a = await computeIdentityCommitment(42n, 0xdeadn)
    const b = await computeIdentityCommitment(42n, 0xbeefn)
    expect(a).not.toBe(b)
  })

  it("different nullifier keys produce different commitments", async () => {
    const a = await computeIdentityCommitment(42n, 0xdeadn)
    const b = await computeIdentityCommitment(43n, 0xdeadn)
    expect(a).not.toBe(b)
  })
})

describe("computePaymentCommitment", () => {
  it("returns a valid hex string", async () => {
    const ic = await computeIdentityCommitment(42n, 0xdeadn)
    const result = await computePaymentCommitment(CHAIN_ID, ic, 0xbeefn, 1000n, 12345n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("is deterministic", async () => {
    const ic = await computeIdentityCommitment(42n, 0xdeadn)
    const a = await computePaymentCommitment(CHAIN_ID, ic, 0xbeefn, 1000n, 12345n)
    const b = await computePaymentCommitment(CHAIN_ID, ic, 0xbeefn, 1000n, 12345n)
    expect(a).toBe(b)
  })

  it("different nonces produce different commitments", async () => {
    const ic = await computeIdentityCommitment(42n, 0xdeadn)
    const a = await computePaymentCommitment(CHAIN_ID, ic, 0xbeefn, 1000n, 1n)
    const b = await computePaymentCommitment(CHAIN_ID, ic, 0xbeefn, 1000n, 2n)
    expect(a).not.toBe(b)
  })

  it("different chain IDs produce different commitments", async () => {
    const ic = await computeIdentityCommitment(42n, 0xdeadn)
    const a = await computePaymentCommitment(1n, ic, 0xbeefn, 1000n, 1n)
    const b = await computePaymentCommitment(2n, ic, 0xbeefn, 1000n, 1n)
    expect(a).not.toBe(b)
  })
})

describe("computeChangeCommitment", () => {
  it("returns a valid hex string", async () => {
    const result = await computeChangeCommitment(CHAIN_ID, 42n, 0xdeadn, 0xbeefn, 1000n, 12345n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("is deterministic", async () => {
    const a = await computeChangeCommitment(CHAIN_ID, 42n, 0xdeadn, 0xbeefn, 1000n, 12345n)
    const b = await computeChangeCommitment(CHAIN_ID, 42n, 0xdeadn, 0xbeefn, 1000n, 12345n)
    expect(a).toBe(b)
  })

  it("structurally identical to paymentCommitment with matching identity commitment", async () => {
    const nullifierKey = 42n
    const address = 0xdeadn
    const token = 0xbeefn
    const amount = 1000n
    const nonce = 1n
    const ic = await computeIdentityCommitment(nullifierKey, address)
    const pc = await computePaymentCommitment(CHAIN_ID, ic, token, amount, nonce)
    const cc = await computeChangeCommitment(CHAIN_ID, nullifierKey, address, token, amount, nonce)
    expect(cc).toBe(pc)
  })

  it("different nonces produce different change commitments", async () => {
    const a = await computeChangeCommitment(CHAIN_ID, 42n, 0xdeadn, 0xbeefn, 1000n, 1n)
    const b = await computeChangeCommitment(CHAIN_ID, 42n, 0xdeadn, 0xbeefn, 1000n, 2n)
    expect(a).not.toBe(b)
  })
})
