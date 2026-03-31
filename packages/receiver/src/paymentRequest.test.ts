import { describe, it, expect } from "vitest"
import { createPaymentRequest } from "./paymentRequest"
import { computeIdentityCommitment, computePaymentCommitment, deriveNullifierKey } from "@invisi-labs/core"
import { validateIPPRequest, caip2ToChainId } from "@invisi-labs/ipp"

describe("createPaymentRequest", () => {
  const baseParams = {
    masterKey: 42n,
    invoiceId: 1n,
    receivingAddress: 0xdeadn,
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as `0x${string}`,
    chainId: 84532n,
    treeId: 1n,
    paymentTypes: ["open", "blind"] as ("open" | "blind" | "credit")[],
  }

  it("creates a valid IPPRequest with correct identityCommitment", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      amount: 100_000_000n,
      endpoint: "https://pay.example.com",
    })

    expect(() => validateIPPRequest(request)).not.toThrow()

    const nk = await deriveNullifierKey(baseParams.masterKey, baseParams.invoiceId)
    const expectedIC = await computeIdentityCommitment(nk, baseParams.receivingAddress)
    expect(request.identityCommitment).toBe(expectedIC)
  })

  it("converts chainId to CAIP-2 network", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      amount: 100_000_000n,
      endpoint: "https://pay.example.com",
    })
    expect(request.network).toBe("eip155:84532")
    expect(caip2ToChainId(request.network)).toBe(84532n)
  })

  it("mode 1a: includes nonce + paymentCommitment when amount is set and multiPayer is false", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      amount: 100_000_000n,
    })
    expect(request.nonce).toBeDefined()
    expect(request.paymentCommitment).toBeDefined()
    expect(request.amount).toBe("100000000")
  })

  it("mode 1a: paymentCommitment matches core computation", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      amount: 100_000_000n,
    })
    const expected = await computePaymentCommitment(
      baseParams.chainId,
      request.identityCommitment as `0x${string}`,
      BigInt(baseParams.tokenAddress),
      100_000_000n,
      BigInt(request.nonce!),
    )
    expect(request.paymentCommitment).toBe(expected)
  })

  it("mode 1b: no nonce when multiPayer is true", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      amount: 100_000_000n,
      endpoint: "https://pay.example.com",
      multiPayer: true,
    })
    expect(request.nonce).toBeUndefined()
    expect(request.paymentCommitment).toBeUndefined()
    expect(request.amount).toBe("100000000")
    expect(request.endpoint).toBe("https://pay.example.com")
  })

  it("mode 2: no amount, no nonce, endpoint required", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      endpoint: "https://pay.example.com",
    })
    expect(request.amount).toBeUndefined()
    expect(request.nonce).toBeUndefined()
    expect(request.endpoint).toBe("https://pay.example.com")
  })

  it("includes meta fields", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      amount: 100_000_000n,
      meta: { merchantName: "Coffee Shop", orderId: "ORD-001" },
    })
    expect(request.meta).toEqual({ merchantName: "Coffee Shop", orderId: "ORD-001" })
  })

  it("sets paymentTypes from params", async () => {
    const request = await createPaymentRequest({
      ...baseParams,
      amount: 100_000_000n,
      paymentTypes: ["open"],
    })
    expect(request.paymentTypes).toEqual(["open"])
  })
})
