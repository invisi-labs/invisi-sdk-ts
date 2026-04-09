import { describe, it, expect } from "vitest"
import { buildPaymentFromRequest } from "./fromRequest"
import { computePaymentCommitment, computeIdentityCommitment, deriveNullifierKey } from "@invisi-labs/core"
import type { IPPRequest } from "@invisi-labs/ipp"

describe("buildPaymentFromRequest", () => {
  const CHAIN_ID = 84532n
  const TOKEN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`
  const AMOUNT = 100_000_000n
  const NONCE = 42n
  const NONCE_HEX = ("0x" + NONCE.toString(16).padStart(64, "0")) as `0x${string}`

  async function makeValidRequest(): Promise<{
    request: IPPRequest
    nonce: `0x${string}`
    paymentCommitment: `0x${string}`
  }> {
    const nullifierKey = await deriveNullifierKey(1n, 1n)
    const ic = await computeIdentityCommitment(nullifierKey, 0xdeadn)
    const pc = await computePaymentCommitment(CHAIN_ID, ic, BigInt(TOKEN_ADDRESS), AMOUNT, NONCE)
    const request: IPPRequest = {
      v: 1, network: "eip155:84532",
      payload: {
        identityCommitment: ic, tokenAddress: TOKEN_ADDRESS, operator: "0x0000000000000000000000000000000000000000",
        treeId: "1", paymentTypes: ["open"], amount: AMOUNT.toString(),
        nonce: NONCE_HEX, paymentCommitment: pc,
      },
    }
    return { request, nonce: NONCE_HEX, paymentCommitment: pc }
  }

  it("returns calldata and approveAmount for valid request", async () => {
    const { request, nonce, paymentCommitment } = await makeValidRequest()
    const result = await buildPaymentFromRequest({ request, nonce, paymentCommitment, amount: AMOUNT })
    expect(result.calldata).toMatch(/^0x/)
    expect(result.approveAmount).toBe(AMOUNT)
  })

  it("calldata uses the provided nonce (deterministic)", async () => {
    const { request, nonce, paymentCommitment } = await makeValidRequest()
    const r1 = await buildPaymentFromRequest({ request, nonce, paymentCommitment, amount: AMOUNT })
    const r2 = await buildPaymentFromRequest({ request, nonce, paymentCommitment, amount: AMOUNT })
    expect(r1.calldata).toBe(r2.calldata)
  })

  it("throws on tampered paymentCommitment", async () => {
    const { request, nonce } = await makeValidRequest()
    await expect(buildPaymentFromRequest({
      request, nonce,
      paymentCommitment: "0x0000000000000000000000000000000000000000000000000000000000000001",
      amount: AMOUNT,
    })).rejects.toThrow("paymentCommitment verification failed")
  })

  it("throws on wrong amount", async () => {
    const { request, nonce, paymentCommitment } = await makeValidRequest()
    await expect(buildPaymentFromRequest({
      request, nonce, paymentCommitment, amount: 999n,
    })).rejects.toThrow("paymentCommitment verification failed")
  })
})
