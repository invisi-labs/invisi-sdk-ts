import { describe, it, expect } from "vitest"
import { encodeIPPRequest, decodeIPPRequest, encodeIPPVoucher, decodeIPPVoucher, decodeIPPMessage } from "./codec"
import type { IPPRequest, IPPVoucher } from "./types"

const SAMPLE_REQUEST: IPPRequest = {
  v: 1,
  network: "eip155:84532",
  type: "request",
  meta: { merchantName: "Coffee Shop", orderId: "ORD-001" },
  payload: {
    identityCommitment: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    operator: "0x1234567890123456789012345678901234567890",
    treeId: "1",
    paymentTypes: ["open", "blind"],
    amount: "100000000",
    endpoint: "https://pay.merchant.com",
  },
}

const MINIMAL_REQUEST: IPPRequest = {
  v: 1,
  network: "eip155:84532",
  type: "request",
  payload: {
    identityCommitment: "0xabc",
    tokenAddress: "0xdef",
    operator: "0x1234567890123456789012345678901234567890",
    treeId: "1",
    paymentTypes: ["open"],
    nonce: "42",
    paymentCommitment: "0x9999",
  },
}

const SAMPLE_VOUCHER: IPPVoucher = {
  v: 1,
  network: "eip155:84532",
  type: "voucher",
  payload: {
    identityCommitment: "0xabc",
    paymentCommitment: "0xdef",
    tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    operator: "0x1234567890123456789012345678901234567890",
    amount: "100000000",
    nonce: "0x123",
    nullifierKey: "0x456",
    treeId: "1",
  },
}

describe("JSON encoding", () => {
  it("encodes to valid JSON string", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "json")
    const parsed = JSON.parse(encoded)
    expect(parsed.v).toBe(1)
    expect(parsed.network).toBe("eip155:84532")
    expect(parsed.payload.paymentTypes).toEqual(["open", "blind"])
  })

  it("omits undefined optional fields", () => {
    const encoded = encodeIPPRequest(MINIMAL_REQUEST, "json")
    const parsed = JSON.parse(encoded)
    expect(parsed.payload.amount).toBeUndefined()
    expect(parsed.payload.endpoint).toBeUndefined()
    expect(parsed.meta).toBeUndefined()
  })

  it("roundtrips correctly", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "json")
    const decoded = decodeIPPRequest(encoded)
    expect(decoded).toEqual(SAMPLE_REQUEST)
  })
})

describe("Compact encoding", () => {
  it("starts with ipp1: prefix", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "compact")
    expect(encoded).toMatch(/^ipp1:/)
  })

  it("produces a valid compact string (prefix + base64url payload)", () => {
    const compact = encodeIPPRequest(SAMPLE_REQUEST, "compact")
    const payload = compact.slice("ipp1:".length)
    // payload is non-empty base64url
    expect(payload.length).toBeGreaterThan(0)
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it("roundtrips correctly", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "compact")
    const decoded = decodeIPPRequest(encoded)
    expect(decoded).toEqual(SAMPLE_REQUEST)
  })

  it("roundtrips minimal request", () => {
    const encoded = encodeIPPRequest(MINIMAL_REQUEST, "compact")
    const decoded = decodeIPPRequest(encoded)
    expect(decoded).toEqual(MINIMAL_REQUEST)
  })

  it("uses Base64URL (no + / = characters)", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "compact")
    const payload = encoded.slice("ipp1:".length)
    expect(payload).not.toMatch(/[+/=]/)
  })
})

describe("decodeIPPRequest auto-detection", () => {
  it("detects JSON format", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "json")
    const decoded = decodeIPPRequest(encoded)
    expect(decoded).toEqual(SAMPLE_REQUEST)
  })

  it("detects compact format", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "compact")
    const decoded = decodeIPPRequest(encoded)
    expect(decoded).toEqual(SAMPLE_REQUEST)
  })

  it("throws on unknown format", () => {
    expect(() => decodeIPPRequest("unknown:data")).toThrow()
  })

  it("validates decoded request", () => {
    const invalid = JSON.stringify({ v: 1, network: "invalid", type: "request" })
    expect(() => decodeIPPRequest(invalid)).toThrow("network")
  })

  it("rejects compact prefix version mismatch", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "compact")
    const tampered = encoded.replace("ipp1:", "ipp2:")
    expect(() => decodeIPPRequest(tampered)).toThrow("version mismatch")
  })
})

describe("voucher codec", () => {
  it("roundtrips json", () => {
    expect(decodeIPPVoucher(encodeIPPVoucher(SAMPLE_VOUCHER, "json"))).toEqual(SAMPLE_VOUCHER)
  })
  it("roundtrips compact", () => {
    expect(decodeIPPVoucher(encodeIPPVoucher(SAMPLE_VOUCHER, "compact"))).toEqual(SAMPLE_VOUCHER)
  })
  it("decodeIPPVoucher rejects a request", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "json")
    expect(() => decodeIPPVoucher(encoded)).toThrow(/type/)
  })
  it("decodeIPPRequest rejects a voucher", () => {
    const encoded = encodeIPPVoucher(SAMPLE_VOUCHER, "json")
    expect(() => decodeIPPRequest(encoded)).toThrow(/type/)
  })
  it("decodeIPPMessage dispatches by type", () => {
    expect(decodeIPPMessage(encodeIPPVoucher(SAMPLE_VOUCHER, "json")).type).toBe("voucher")
    expect(decodeIPPMessage(encodeIPPRequest(SAMPLE_REQUEST, "json")).type).toBe("request")
  })
})
