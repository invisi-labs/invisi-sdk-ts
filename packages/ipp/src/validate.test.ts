import { describe, it, expect } from "vitest"
import { validateIPPRequest } from "./validate"
import type { IPPRequest, IPPPayloadV1 } from "./types"

function makeRequest(payload: Partial<IPPPayloadV1> & Pick<IPPPayloadV1, "mode">): IPPRequest {
  return {
    v: 1,
    network: "eip155:84532",
    type: "request",
    payload: {
      identityCommitment: "0xabc",
      tokenAddress: "0xdef",
      operator: "0x1234567890123456789012345678901234567890",
      paymentTypes: ["open", "blind"],
      endpoint: "https://pay.merchant.com",
      ...payload,
    },
  }
}

describe("validateIPPRequest — envelope & required fields", () => {
  it("passes a well-formed single request", () => {
    expect(() => validateIPPRequest(makeRequest({ mode: "single", amount: "100" }))).not.toThrow()
  })

  it("throws when v < 1", () => {
    const req = makeRequest({ mode: "single", amount: "100" })
    req.v = 0
    expect(() => validateIPPRequest(req)).toThrow(/v must be/i)
  })

  it("throws on non-CAIP-2 network", () => {
    const req = makeRequest({ mode: "single", amount: "100" })
    req.network = "mainnet"
    expect(() => validateIPPRequest(req)).toThrow(/CAIP-2/i)
  })

  it("throws when identityCommitment missing", () => {
    const req = makeRequest({ mode: "single", amount: "100" })
    // @ts-expect-error deliberately drop a required field to exercise the runtime guard
    delete req.payload.identityCommitment
    expect(() => validateIPPRequest(req)).toThrow(/identityCommitment/i)
  })

  it("throws when paymentTypes empty", () => {
    expect(() => validateIPPRequest(makeRequest({ mode: "single", amount: "100", paymentTypes: [] }))).toThrow(
      /paymentTypes/i,
    )
  })

  it("throws on invalid payment type", () => {
    expect(() =>
      // @ts-expect-error invalid payment type value
      validateIPPRequest(makeRequest({ mode: "single", amount: "100", paymentTypes: ["bogus"] })),
    ).toThrow(/invalid type/i)
  })
})

describe("validateIPPRequest — SPEC-029 mode ⇒ endpoint baseline", () => {
  it("multi without endpoint throws", () => {
    const req = makeRequest({ mode: "multi" })
    delete req.payload.endpoint
    expect(() => validateIPPRequest(req)).toThrow(/endpoint/i)
  })

  it("single without endpoint throws", () => {
    const req = makeRequest({ mode: "single", amount: "100" })
    delete req.payload.endpoint
    expect(() => validateIPPRequest(req)).toThrow(/endpoint/i)
  })

  it("single WITHOUT amount still passes baseline (amount-per-mode is an encoding-tightening rule, not baseline)", () => {
    const req = makeRequest({ mode: "single" })
    delete req.payload.amount
    expect(() => validateIPPRequest(req)).not.toThrow()
  })

  it("multi with endpoint passes (open amount)", () => {
    expect(() => validateIPPRequest(makeRequest({ mode: "multi" }))).not.toThrow()
  })

  it("modeless credit request passes even without endpoint (rule fires only for explicit single/multi)", () => {
    // Defensive behavior for runtime data whose mode is absent: the validator must
    // not force endpoint when mode is not an explicit single/multi.
    const req: IPPRequest = {
      v: 1,
      network: "eip155:84532",
      type: "request",
      payload: {
        identityCommitment: "0xabc",
        tokenAddress: "0xdef",
        operator: "0x1234567890123456789012345678901234567890",
        paymentTypes: ["credit"],
        creditId: "credit_abc123",
        // mode intentionally omitted (runtime-untrusted shape)
      } as unknown as IPPPayloadV1,
    }
    expect(() => validateIPPRequest(req)).not.toThrow()
  })
})
