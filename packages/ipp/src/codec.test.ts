import { describe, it, expect } from "vitest"
import { encodeIPPRequest, decodeIPPRequest, encodeIPPVoucher, decodeIPPVoucher, decodeIPPMessage } from "./codec"
import type { IPPMessage, IPPRequest, IPPVoucher } from "./types"

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
    // wire field is snake_case (paymentTypes → payment_types).
    expect(parsed.payload.payment_types).toEqual(["open", "blind"])
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

// wire is snake_case, TS property names stay camelCase. The codec
// converts at the (de)serialization boundary, recursively across nested
// objects + arrays of objects, while exempting the `meta` map's keys.
describe("wire snake_case round-trip", () => {
  // An IPPMessage carrying a nested witness (with an array of merkle proofs)
  // and a paymaster object — mirrors the shape of a WithdrawResponse witness —
  // plus a meta map with a namespaced business key. The structural codec walks
  // arbitrary IPP message objects, so this exercises full-depth key conversion.
  const NESTED_MESSAGE = {
    v: 1,
    network: "eip155:84532",
    type: "voucher",
    meta: {
      merchantName: "Coffee Shop",
      orderId: "ORD-001",
      expiresAt: "2026-06-24T00:00:00Z",
      "invisi.subscriptionId": "sub_123",
    },
    payload: {
      identityCommitment: "0xabc",
      paymentCommitment: "0xdef",
      tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      operator: "0x1234567890123456789012345678901234567890",
      amount: "100000000",
      nonce: "0x123",
      nullifierKey: "0x456",
      treeId: "1",
      witness: {
        merkleRoot: "0xroot",
        totalAmount: "200000000",
        receivingAddress: "0xrecv",
        merkleProofs: [
          { leafIndex: "3", merklePath: ["0xa", "0xb"], receiverCommitment: "0xc1" },
          { leafIndex: "7", merklePath: ["0xc", "0xd"], receiverCommitment: "0xc2" },
        ],
      },
      paymaster: { url: "https://pm.example", policyId: "pol_1" },
    },
  } as unknown as IPPMessage

  it("JSON wire keys are snake, decode returns camel (deep-equal original)", () => {
    const json = encodeIPPVoucher(NESTED_MESSAGE as IPPVoucher, "json")

    // canonical wire fields are snake_case at every depth ...
    expect(json).toContain("identity_commitment")
    expect(json).toContain("payment_commitment")
    expect(json).toContain("token_address")
    expect(json).toContain("nullifier_key")
    expect(json).toContain("tree_id")
    expect(json).toContain("merkle_root")
    expect(json).toContain("total_amount")
    expect(json).toContain("receiving_address")
    expect(json).toContain("merkle_proofs")
    expect(json).toContain("leaf_index")
    expect(json).toContain("merkle_path")
    expect(json).toContain("receiver_commitment")
    expect(json).toContain("policy_id")
    // ... and no camelCase leaked into the wire body (outside meta).
    expect(json).not.toContain("identityCommitment")
    expect(json).not.toContain("merkleProofs")
    expect(json).not.toContain("treeId")
    expect(json).not.toContain("leafIndex")
    expect(json).not.toContain("receiverCommitment")
    expect(json).not.toContain("policyId")

    // decode round-trips back to the original camelCase property shape.
    const decoded = decodeIPPMessage(json)
    expect(decoded).toEqual(NESTED_MESSAGE)
  })

  it("compact (msgpack) wire keys are snake, decode returns camel (deep-equal original)", () => {
    const compact = encodeIPPVoucher(NESTED_MESSAGE as IPPVoucher, "compact")
    expect(compact).toMatch(/^ipp1:/)

    // Inspect the msgpack payload bytes: snake keys present, camel absent.
    const payload = compact.slice("ipp1:".length)
    const base64 = payload.replace(/-/g, "+").replace(/_/g, "/")
    const raw = Buffer.from(base64, "base64").toString("latin1")
    expect(raw).toContain("identity_commitment")
    expect(raw).toContain("merkle_proofs")
    expect(raw).toContain("tree_id")
    expect(raw).toContain("receiver_commitment")
    expect(raw).not.toContain("identityCommitment")
    expect(raw).not.toContain("merkleProofs")
    expect(raw).not.toContain("treeId")
    expect(raw).not.toContain("receiverCommitment")

    const decoded = decodeIPPMessage(compact)
    expect(decoded).toEqual(NESTED_MESSAGE)
  })

  it("meta map keys are NOT converted (preserved verbatim, incl. namespaced)", () => {
    const json = encodeIPPVoucher(NESTED_MESSAGE as IPPVoucher, "json")
    const parsed = JSON.parse(json)

    // meta business keys survive as-is — not snake_cased.
    expect(parsed.meta).toEqual({
      merchantName: "Coffee Shop",
      orderId: "ORD-001",
      expiresAt: "2026-06-24T00:00:00Z",
      "invisi.subscriptionId": "sub_123",
    })
    expect(json).toContain('"merchantName"')
    expect(json).toContain('"expiresAt"')
    expect(json).toContain('"invisi.subscriptionId"')
    expect(json).not.toContain("merchant_name")
    expect(json).not.toContain("expires_at")
    expect(json).not.toContain("subscription_id")
  })
})
