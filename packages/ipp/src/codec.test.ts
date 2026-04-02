import { describe, it, expect } from "vitest"
import { encodeIPPRequest, decodeIPPRequest } from "./codec"
import type { IPPRequest } from "./types"

const SAMPLE_REQUEST: IPPRequest = {
  v: 1,
  operator: "0x1234567890123456789012345678901234567890",
  network: "eip155:84532",
  identityCommitment: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  treeId: "1",
  paymentTypes: ["open", "blind"],
  amount: "100000000",
  endpoint: "https://pay.merchant.com",
  meta: {
    merchantName: "Coffee Shop",
    orderId: "ORD-001",
  },
}

const MINIMAL_REQUEST: IPPRequest = {
  v: 1,
  operator: "0x1234567890123456789012345678901234567890",
  network: "eip155:84532",
  identityCommitment: "0xabc",
  tokenAddress: "0xdef",
  treeId: "1",
  paymentTypes: ["open"],
  nonce: "42",
  paymentCommitment: "0x9999",
}

describe("JSON encoding", () => {
  it("encodes to valid JSON string", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "json")
    const parsed = JSON.parse(encoded)
    expect(parsed.v).toBe(1)
    expect(parsed.network).toBe("eip155:84532")
    expect(parsed.paymentTypes).toEqual(["open", "blind"])
  })

  it("omits undefined optional fields", () => {
    const encoded = encodeIPPRequest(MINIMAL_REQUEST, "json")
    const parsed = JSON.parse(encoded)
    expect(parsed.amount).toBeUndefined()
    expect(parsed.endpoint).toBeUndefined()
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
    const invalid = JSON.stringify({ v: 1, network: "invalid" })
    expect(() => decodeIPPRequest(invalid)).toThrow("network")
  })

  it("rejects compact prefix version mismatch", () => {
    const encoded = encodeIPPRequest(SAMPLE_REQUEST, "compact")
    const tampered = encoded.replace("ipp1:", "ipp2:")
    expect(() => decodeIPPRequest(tampered)).toThrow("version mismatch")
  })
})
