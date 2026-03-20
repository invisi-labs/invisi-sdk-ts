import { describe, it, expect } from "vitest"
import { computeReceiverCommitment, computePaymentCommitment } from "./commitment"
import { poseidonHash } from "./poseidon"

describe("computeReceiverCommitment", () => {
  it("returns a 32-byte hex string", async () => {
    const result = await computeReceiverCommitment(42n, 0xdeadn)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("equals poseidon([claimingKey, receivingAddress])", async () => {
    const claimingKey = 999n
    const receivingAddress = 0xdeadn
    const expected = await poseidonHash([claimingKey, receivingAddress])
    expect(await computeReceiverCommitment(claimingKey, receivingAddress)).toBe(expected)
  })

  it("different addresses produce different commitments", async () => {
    const a = await computeReceiverCommitment(42n, 0xdeadn)
    const b = await computeReceiverCommitment(42n, 0xbeefn)
    expect(a).not.toBe(b)
  })
})

describe("computePaymentCommitment", () => {
  it("returns a 32-byte hex string", async () => {
    const rc = await computeReceiverCommitment(42n, 0xdeadn)
    const result = await computePaymentCommitment(rc, 0xbeefn, 1000n, 12345n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("equals poseidon([receiverCommitment, tokenAddress, amount, nonce])", async () => {
    const rc = await computeReceiverCommitment(42n, 0xdeadn)
    const expected = await poseidonHash([BigInt(rc), 0xbeefn, 1000n, 12345n])
    const result = await computePaymentCommitment(rc, 0xbeefn, 1000n, 12345n)
    expect(result).toBe(expected)
  })

  it("different nonces produce different commitments", async () => {
    const rc = await computeReceiverCommitment(42n, 0xdeadn)
    const a = await computePaymentCommitment(rc, 0xbeefn, 1000n, 1n)
    const b = await computePaymentCommitment(rc, 0xbeefn, 1000n, 2n)
    expect(a).not.toBe(b)
  })
})
