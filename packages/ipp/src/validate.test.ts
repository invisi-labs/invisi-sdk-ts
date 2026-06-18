import { describe, it, expect } from "vitest"
import { validateIPPRequest } from "./validate"
import type { IPPRequest } from "./types"

// 模式 1a：有 nonce + paymentCommitment，endpoint 可选
const MODE_1A_REQUEST: IPPRequest = {
  v: 1,
  network: "eip155:84532",
  type: "request",
  payload: {
    operator: "0x1234567890123456789012345678901234567890",
    identityCommitment: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    treeId: "1",
    paymentTypes: ["open", "blind"],
    amount: "100000000",
    nonce: "42",
    paymentCommitment: "0xabcdef",
  },
}

// 模式 1b：有 amount，无 nonce，需要 endpoint
const MODE_1B_REQUEST: IPPRequest = {
  v: 1,
  network: "eip155:84532",
  type: "request",
  payload: {
    operator: "0x1234567890123456789012345678901234567890",
    identityCommitment: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    treeId: "1",
    paymentTypes: ["open", "blind"],
    amount: "100000000",
    endpoint: "https://pay.merchant.com",
  },
}

describe("validateIPPRequest", () => {
  it("accepts mode 1a request (nonce + paymentCommitment, no endpoint)", () => {
    expect(() => validateIPPRequest(MODE_1A_REQUEST)).not.toThrow()
  })

  it("accepts mode 1a with optional endpoint", () => {
    expect(() =>
      validateIPPRequest({
        ...MODE_1A_REQUEST,
        payload: {
          ...MODE_1A_REQUEST.payload,
          endpoint: "https://pay.example.com",
        },
      }),
    ).not.toThrow()
  })

  it("accepts mode 1b (amount + endpoint, no nonce)", () => {
    expect(() => validateIPPRequest(MODE_1B_REQUEST)).not.toThrow()
  })

  it("accepts mode 2 (no amount, with endpoint)", () => {
    const { amount: _a, nonce: _n, paymentCommitment: _p, ...basePayload } = MODE_1A_REQUEST.payload
    expect(() =>
      validateIPPRequest({
        ...MODE_1A_REQUEST,
        payload: {
          ...basePayload,
          endpoint: "https://pay.example.com",
        },
      } as IPPRequest),
    ).not.toThrow()
  })

  it("rejects if v is missing", () => {
    const { v: _, ...rest } = MODE_1A_REQUEST
    expect(() => validateIPPRequest(rest as IPPRequest)).toThrow("v")
  })

  it("rejects if network is not CAIP-2 format", () => {
    expect(() =>
      validateIPPRequest({ ...MODE_1A_REQUEST, network: "ethereum" }),
    ).toThrow("network")
  })

  it("rejects if payload is missing", () => {
    const { payload: _, ...rest } = MODE_1A_REQUEST
    expect(() => validateIPPRequest(rest as IPPRequest)).toThrow("payload")
  })

  it("rejects if paymentTypes is empty", () => {
    expect(() =>
      validateIPPRequest({
        ...MODE_1A_REQUEST,
        payload: { ...MODE_1A_REQUEST.payload, paymentTypes: [] },
      }),
    ).toThrow("paymentTypes")
  })

  it("rejects if paymentTypes contains invalid type", () => {
    expect(() =>
      validateIPPRequest({
        ...MODE_1A_REQUEST,
        payload: {
          ...MODE_1A_REQUEST.payload,
          paymentTypes: ["open", "invalid" as any],
        },
      }),
    ).toThrow("paymentTypes")
  })

  it("rejects nonce without paymentCommitment", () => {
    const { paymentCommitment: _, ...noPC } = MODE_1A_REQUEST.payload
    expect(() =>
      validateIPPRequest({
        ...MODE_1A_REQUEST,
        payload: { ...noPC, endpoint: "https://x.com" },
      } as IPPRequest),
    ).toThrow("nonce")
  })

  it("rejects paymentCommitment without nonce", () => {
    const { nonce: _, ...noNonce } = MODE_1A_REQUEST.payload
    expect(() =>
      validateIPPRequest({
        ...MODE_1A_REQUEST,
        payload: { ...noNonce, endpoint: "https://x.com" },
      } as IPPRequest),
    ).toThrow("nonce")
  })

  it("rejects mode 1b without endpoint (amount set, no nonce)", () => {
    const { endpoint: _, ...noEndpoint } = MODE_1B_REQUEST.payload
    expect(() =>
      validateIPPRequest({
        ...MODE_1B_REQUEST,
        payload: noEndpoint,
      } as IPPRequest),
    ).toThrow("endpoint")
  })

  it("rejects mode 2 without endpoint (no amount, no nonce)", () => {
    const { amount: _a, nonce: _n, paymentCommitment: _p, ...basePayload } = MODE_1A_REQUEST.payload
    expect(() =>
      validateIPPRequest({
        ...MODE_1A_REQUEST,
        payload: basePayload,
      } as IPPRequest),
    ).toThrow("endpoint")
  })
})
