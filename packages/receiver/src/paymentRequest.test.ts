import { describe, it, expect } from "vitest"
import { createPaymentRequest } from "./paymentRequest"
import { computeIdentityCommitment, deriveNullifierKey } from "@invisi-labs/core"
import { validateIPPRequest, caip2ToChainId } from "@invisi-labs/ipp"

describe("createPaymentRequest", () => {
  const baseParams = {
    masterKey: 42n,
    invoiceId: 1n,
    receivingAddress: 0xdeadn,
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
    chainId: 84532n,
    operator: "0x1234567890123456789012345678901234567890" as `0x${string}`,
    paymentTypes: ["open", "blind"] as ("open" | "blind" | "credit")[],
  }

  it("creates a valid IPPRequest with correct identityCommitment", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      mode: "single",
      amount: 100_000_000n,
      endpoint: "https://pay.example.com",
    })

    expect(() => validateIPPRequest(request)).not.toThrow()

    const nk = await deriveNullifierKey(baseParams.masterKey, baseParams.invoiceId)
    const expectedIC = await computeIdentityCommitment(nk, baseParams.receivingAddress)
    expect(request.payload.identityCommitment).toBe(expectedIC)
  })

  it("converts chainId to CAIP-2 network", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      mode: "single",
      amount: 100_000_000n,
      endpoint: "https://pay.example.com",
    })
    expect(request.network).toBe("eip155:84532")
    expect(caip2ToChainId(request.network)).toBe(84532n)
  })

  it("single mode: payload carries mode='single', no prefilled materials", async () => {
    const req = await createPaymentRequest({
      masterKey: 999n,
      invoiceId: 1n,
      receivingAddress: 0xdeadn,
      tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chainId: 84532n,
      operator: "0x1234567890123456789012345678901234567890",
      paymentTypes: ["open", "blind"],
      mode: "single",
      endpoint: "https://pay.merchant.com",
      amount: 100_000_000n,
    })
    expect(req.payload.mode).toBe("single")
    expect(req.payload.amount).toBe("100000000")
    expect(req.payload.endpoint).toBe("https://pay.merchant.com")
    expect("nonce" in req.payload).toBe(false)
    expect("paymentCommitment" in req.payload).toBe(false)
    expect("treeId" in req.payload).toBe(false)
  })

  it("multi mode: open amount, mode='multi'", async () => {
    const req = await createPaymentRequest({
      masterKey: 999n,
      invoiceId: 2n,
      receivingAddress: 0xdeadn,
      tokenAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      chainId: 84532n,
      operator: "0x1234567890123456789012345678901234567890",
      paymentTypes: ["open"],
      mode: "multi",
      endpoint: "https://pay.merchant.com",
    })
    expect(req.payload.mode).toBe("multi")
    expect("amount" in req.payload).toBe(false)
  })

  it("includes meta fields", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      mode: "single",
      amount: 100_000_000n,
      meta: { merchantName: "Coffee Shop", orderId: "ORD-001" },
    })
    expect(request.meta).toEqual({ merchantName: "Coffee Shop", orderId: "ORD-001" })
  })

  it("sets paymentTypes from params", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      mode: "single",
      amount: 100_000_000n,
      paymentTypes: ["open"],
    })
    expect(request.payload.paymentTypes).toEqual(["open"])
  })
})
