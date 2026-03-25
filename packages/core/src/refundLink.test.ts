import { describe, it, expect } from "vitest"
import { computeRefundLink } from "./refundLink"

describe("computeRefundLink", () => {
  it("should compute refundLink from originalCommitment and refundNonce", async () => {
    const originalCommitment = 0x1234n
    const refundNonce = 0x5678n
    const result = await computeRefundLink(originalCommitment, refundNonce)
    expect(result).toBeDefined()
    expect(result).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it("should produce different results for different refundNonce", async () => {
    const originalCommitment = 0x1234n
    const link1 = await computeRefundLink(originalCommitment, 0xaaan)
    const link2 = await computeRefundLink(originalCommitment, 0xbbbn)
    expect(link1).not.toBe(link2)
  })

  it("should produce different results for different originalCommitment", async () => {
    const refundNonce = 0x5678n
    const link1 = await computeRefundLink(0x1111n, refundNonce)
    const link2 = await computeRefundLink(0x2222n, refundNonce)
    expect(link1).not.toBe(link2)
  })
})
