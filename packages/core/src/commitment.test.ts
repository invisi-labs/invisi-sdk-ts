import { describe, it, expect } from "vitest"
import { computeReceiverCommitment, computePaymentCommitment } from "./commitment"
import { poseidonHash } from "./poseidon"

describe("computeReceiverCommitment", () => {
  it("returns a 32-byte hex string", async () => {
    const result = await computeReceiverCommitment(42n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("equals poseidon([claimingKey])", async () => {
    const claimingKey = 999n
    const expected = await poseidonHash([claimingKey])
    expect(await computeReceiverCommitment(claimingKey)).toBe(expected)
  })
})

describe("computePaymentCommitment", () => {
  it("returns a 32-byte hex string", async () => {
    const result = await computePaymentCommitment(42n, 1_000_000_000_000_000_000n)
    expect(result).toMatch(/^0x[0-9a-f]{64}$/i)
  })
})
