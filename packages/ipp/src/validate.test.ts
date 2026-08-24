import { describe, it, expect } from "vitest"
import { validateIPPRequest, validateIPPVoucher } from "./validate"
import type { IPPRequest, IPPPayloadV1, IPPVoucher, IPPVoucherV1 } from "./types"

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

function makeVoucher(payload: Partial<IPPVoucherV1> = {}): IPPVoucher {
  return {
    v: 1,
    network: "eip155:84532",
    type: "voucher",
    payload: {
      receivingAddress: "0xabc0000000000000000000000000000000abc",
      paymentCommitment: "0xcommit",
      tokenAddress: "0xdef",
      operator: "0x1234567890123456789012345678901234567890",
      amount: "100",
      nonce: "0xnonce",
      nullifierKey: "0xnullifier",
      treeId: "1",
      endpoint: "https://pay.merchant.com",
      ...payload,
    },
  }
}

const REQUIRED_VOUCHER_PAYLOAD_FIELDS: (keyof IPPVoucherV1)[] = [
  "receivingAddress",
  "paymentCommitment",
  "tokenAddress",
  "operator",
  "amount",
  "nonce",
  "nullifierKey",
  "treeId",
  "endpoint",
]

describe("validateIPPVoucher — envelope & required fields", () => {
  it("passes a well-formed voucher", () => {
    expect(() => validateIPPVoucher(makeVoucher())).not.toThrow()
  })

  it("throws when v < 1", () => {
    const voucher = makeVoucher()
    voucher.v = 0
    expect(() => validateIPPVoucher(voucher)).toThrow(/v must be/i)
  })

  it("throws on non-CAIP-2 network", () => {
    const voucher = makeVoucher()
    voucher.network = "mainnet"
    expect(() => validateIPPVoucher(voucher)).toThrow(/CAIP-2/i)
  })

  it("throws when type is not \"voucher\"", () => {
    const voucher = makeVoucher()
    // @ts-expect-error deliberately set an invalid discriminator to exercise the runtime guard
    voucher.type = "request"
    expect(() => validateIPPVoucher(voucher)).toThrow(/type must be/i)
  })

  it.each(REQUIRED_VOUCHER_PAYLOAD_FIELDS)("throws when %s missing, naming the field", (field) => {
    const voucher = makeVoucher()
    delete voucher.payload[field]
    const pattern = new RegExp(field, "i")
    expect(() => validateIPPVoucher(voucher)).toThrow(pattern)
  })

  it("throws when endpoint is not a valid URL", () => {
    expect(() => validateIPPVoucher(makeVoucher({ endpoint: "not a url" }))).toThrow(/endpoint/i)
  })

  it("passes when endpoint is http://localhost (SDK does not enforce scheme)", () => {
    expect(() => validateIPPVoucher(makeVoucher({ endpoint: "http://localhost:3000" }))).not.toThrow()
  })

  it("passes when leafIndex is absent (optional field)", () => {
    const voucher = makeVoucher()
    delete voucher.payload.leafIndex
    expect(() => validateIPPVoucher(voucher)).not.toThrow()
  })
})
