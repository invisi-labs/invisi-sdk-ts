import { describe, it, expect } from "vitest"
import { computePaymentCommitmentForPropose } from "./propose"
import { computePaymentCommitment } from "@invisi/core"

describe("computePaymentCommitmentForPropose", () => {
  const params = {
    identityCommitment: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" as `0x${string}`,
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
    amount: 100_000_000n,
    chainId: 84532n,
  }

  it("returns nonce and paymentCommitment", async () => {
    const result = await computePaymentCommitmentForPropose(params)
    expect(result.nonce).toMatch(/^0x[0-9a-f]{64}$/i)
    expect(result.paymentCommitment).toMatch(/^0x[0-9a-f]{64}$/i)
  })

  it("produces different nonces on each call", async () => {
    const a = await computePaymentCommitmentForPropose(params)
    const b = await computePaymentCommitmentForPropose(params)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.paymentCommitment).not.toBe(b.paymentCommitment)
  })

  it("paymentCommitment matches core computation", async () => {
    const result = await computePaymentCommitmentForPropose(params)
    const expected = await computePaymentCommitment(
      params.chainId,
      params.identityCommitment,
      BigInt(params.tokenAddress),
      params.amount,
      BigInt(result.nonce),
    )
    expect(result.paymentCommitment).toBe(expected)
  })
})
