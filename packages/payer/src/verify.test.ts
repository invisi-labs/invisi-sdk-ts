import { describe, it, expect } from "vitest"
import { verifyPaymentCommitment } from "./verify"
import { computePaymentCommitment, computeIdentityCommitment, deriveNullifierKey } from "@invisi/core"

describe("verifyPaymentCommitment", () => {
  const CHAIN_ID = 84532n
  const TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`
  const AMOUNT = 100_000_000n
  const NONCE = 42n
  const NONCE_HEX = ("0x" + NONCE.toString(16).padStart(64, "0")) as `0x${string}`

  it("returns true for valid paymentCommitment", async () => {
    const nullifierKey = await deriveNullifierKey(1n, 1n)
    const ic = await computeIdentityCommitment(nullifierKey, 0xdeadn)
    const pc = await computePaymentCommitment(CHAIN_ID, ic, BigInt(TOKEN_ADDRESS), AMOUNT, NONCE)

    const valid = await verifyPaymentCommitment({
      identityCommitment: ic, tokenAddress: TOKEN_ADDRESS, amount: AMOUNT,
      nonce: NONCE_HEX, paymentCommitment: pc, chainId: CHAIN_ID,
    })
    expect(valid).toBe(true)
  })

  it("returns false for tampered paymentCommitment", async () => {
    const nullifierKey = await deriveNullifierKey(1n, 1n)
    const ic = await computeIdentityCommitment(nullifierKey, 0xdeadn)

    const valid = await verifyPaymentCommitment({
      identityCommitment: ic, tokenAddress: TOKEN_ADDRESS, amount: AMOUNT,
      nonce: NONCE_HEX,
      paymentCommitment: "0x0000000000000000000000000000000000000000000000000000000000000001",
      chainId: CHAIN_ID,
    })
    expect(valid).toBe(false)
  })

  it("returns false for wrong amount", async () => {
    const nullifierKey = await deriveNullifierKey(1n, 1n)
    const ic = await computeIdentityCommitment(nullifierKey, 0xdeadn)
    const pc = await computePaymentCommitment(CHAIN_ID, ic, BigInt(TOKEN_ADDRESS), AMOUNT, NONCE)

    const valid = await verifyPaymentCommitment({
      identityCommitment: ic, tokenAddress: TOKEN_ADDRESS, amount: 999n,
      nonce: NONCE_HEX, paymentCommitment: pc, chainId: CHAIN_ID,
    })
    expect(valid).toBe(false)
  })
})
