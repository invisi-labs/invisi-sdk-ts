import { describe, it, expect, vi, beforeEach } from "vitest"
import { IPPClient } from "./client"
import {
  InvalidRequestError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ApiError,
  ConnectionError,
} from "./errors"
import type { ErrorEnvelope } from "./errors"

const ENDPOINT = "https://pay.example.com"
const BASE_URL = `${ENDPOINT}/ipp/v1`

const mockFetch = vi.fn()
globalThis.fetch = mockFetch

// Mock payloads are snake_case — that is the real /ipp/v1 wire.
// The client must encode camelCase→snake on the way out and decode
// snake→camelCase on the way back, so these assertions read camelCase props.
function mockJsonResponse(data: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve(data),
  })
}

// The gateway wraps every 4xx/5xx in a Stripe-style NESTED envelope
// `{error:{type,code,message,param,request_id,details}}` — already snake_case,
// read verbatim into the typed error (no snake→camel transcode).
function mockEnvelopeError(status: number, error: ErrorEnvelope) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
  })
}

// Error response whose body is not JSON (json() rejects) — no envelope to type.
function mockNonJsonError(status: number) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
  })
}

// Error response whose body parses but lacks the nested {error:{...}} shape.
function mockShapelessError(status: number, body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  })
}

// The JSON body actually written to the wire on the most recent call.
function sentBody(): Record<string, unknown> {
  const calls = mockFetch.mock.calls
  const last = calls[calls.length - 1]
  return JSON.parse(last[1].body as string)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("IPPClient", () => {
  const client = new IPPClient(ENDPOINT)

  it("info: POST /ipp/v1/info — snake body, snake→camel response", async () => {
    mockJsonResponse({ merchant_name: "Coffee Shop", amount: "100000000" })
    const result = await client.info({ identityCommitment: "0xabc" })
    expect(sentBody()).toEqual({ identity_commitment: "0xabc" })
    expect(result.merchantName).toBe("Coffee Shop")
    expect(result.amount).toBe("100000000")
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/info`,
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("propose: POST /ipp/v1/propose", async () => {
    mockJsonResponse({ status: "accepted", nonce: "0x42", payment_commitment: "0xdef" })
    const result = await client.propose({ identityCommitment: "0xabc", amount: "100000000" })
    expect(sentBody()).toEqual({ identity_commitment: "0xabc", amount: "100000000" })
    expect(result.status).toBe("accepted")
    expect(result.nonce).toBe("0x42")
    expect(result.paymentCommitment).toBe("0xdef")
  })

  it("authorize: POST /ipp/v1/authorize", async () => {
    mockJsonResponse({ status: "accepted", nonce: "0x42", credit_commitment: "0xccc", nullifier_key_hash: "0xnkh" })
    // credit_nullifier_key + subscription_id ride the generic camelCase→snake_case
    // wire conversion (no bespoke codec entry), so assert their round-trip here.
    const result = await client.authorize({
      identityCommitment: "0xabc",
      amount: "1000000",
      expiry: "1711900000",
      creditNullifierKey: "0xcnk",
      subscriptionId: "sub_1",
    })
    expect(sentBody()).toEqual({
      identity_commitment: "0xabc",
      amount: "1000000",
      expiry: "1711900000",
      credit_nullifier_key: "0xcnk",
      subscription_id: "sub_1",
    })
    expect(result.status).toBe("accepted")
    expect(result.creditCommitment).toBe("0xccc")
    expect(result.nullifierKeyHash).toBe("0xnkh")
  })

  it("status: GET /ipp/v1/status/{paymentCommitment}", async () => {
    mockJsonResponse({ status: "confirmed", tx_hash: "0xtx" })
    const result = await client.status("0xpayment")
    expect(result.status).toBe("confirmed")
    expect(result.txHash).toBe("0xtx")
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/status/0xpayment`, expect.objectContaining({ method: "GET" }))
  })

  it("notify: POST /ipp/v1/notify", async () => {
    mockJsonResponse({ status: "received" })
    const result = await client.notify({ commitment: "0xabc", action: "submitted" as const, txHash: "0xtx", network: "eip155:84532" })
    expect(sentBody()).toEqual({ commitment: "0xabc", action: "submitted", tx_hash: "0xtx", network: "eip155:84532" })
    expect(result.status).toBe("received")
  })

  it("sends cancel notify", async () => {
    mockJsonResponse({ status: "received" })
    const result = await client.notify({
      commitment: "0xabc",
      action: "cancelled",
    })
    expect(sentBody()).toEqual({ commitment: "0xabc", action: "cancelled" })
    expect(result.status).toBe("received")
  })

  it("withdraw: POST /ipp/v1/withdraw — recursive snake/camel across witness", async () => {
    mockJsonResponse({
      status: "accepted",
      witness: { merkle_root: "0xroot", nullifiers: ["0xn1"], total_amount: "100000000", receiving_address: "0xaddr", merkle_proofs: [] },
      circuit: "batch_settle_1",
    })
    const result = await client.withdraw({ identityCommitment: "0xabc", tokenAddress: "0xtoken", treeId: "1", paymentCommitments: ["0xp1"] })
    expect(sentBody()).toEqual({ identity_commitment: "0xabc", token_address: "0xtoken", tree_id: "1", payment_commitments: ["0xp1"] })
    expect(result.status).toBe("accepted")
    expect(result.circuit).toBe("batch_settle_1")
    expect(result.witness?.merkleRoot).toBe("0xroot")
    expect(result.witness?.totalAmount).toBe("100000000")
    expect(result.witness?.receivingAddress).toBe("0xaddr")
    expect(result.witness?.merkleProofs).toEqual([])
  })

  it("creditDraw: POST /ipp/v1/credit-draw", async () => {
    mockJsonResponse({ status: "accepted", circuit: "credit_draw_1" })
    const result = await client.creditDraw({ identityCommitment: "0xabc", tokenAddress: "0xtoken", treeId: "1", creditCommitments: ["0xc1"], amounts: ["50000000"] })
    expect(sentBody()).toEqual({ identity_commitment: "0xabc", token_address: "0xtoken", tree_id: "1", credit_commitments: ["0xc1"], amounts: ["50000000"] })
    expect(result.status).toBe("accepted")
  })

  it("creditReclaim: POST /ipp/v1/credit-reclaim", async () => {
    mockJsonResponse({ status: "accepted", circuit: "credit_reclaim" })
    const result = await client.creditReclaim({ creditCommitment: "0xcc", tokenAddress: "0xtoken", treeId: "1" })
    expect(sentBody()).toEqual({ credit_commitment: "0xcc", token_address: "0xtoken", tree_id: "1" })
    expect(result.status).toBe("accepted")
  })

  it("creditStatus: GET /ipp/v1/credit/{creditCommitment}", async () => {
    mockJsonResponse({
      status: "active", original_amount: "1000000", drawn_amount: "500000", remainder_amount: "500000",
      expiry: "1711900000", draws: [{ amount: "500000", timestamp: "1711800000", tx_hash: "0xtx" }],
    })
    const result = await client.creditStatus("0xcc")
    expect(result.status).toBe("active")
    expect(result.originalAmount).toBe("1000000")
    expect(result.drawnAmount).toBe("500000")
    expect(result.remainderAmount).toBe("500000")
    expect(result.draws[0]?.txHash).toBe("0xtx")
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/credit/0xcc`, expect.objectContaining({ method: "GET" }))
  })

  it("relay: POST /ipp/v1/relay (signature mode)", async () => {
    mockJsonResponse({ status: "submitted", tx_hash: "0xtx" })
    const result = await client.relay({
      mode: "signature", operation: "pay-open", network: "eip155:84532", signature: "0xsig",
      paymentCommitment: "0xpc", identityCommitment: "0xic", tokenAddress: "0xtoken",
      amount: "100000000", nonce: "0x42", treeId: "1",
    })
    expect(sentBody()).toEqual({
      mode: "signature", operation: "pay-open", network: "eip155:84532", signature: "0xsig",
      payment_commitment: "0xpc", identity_commitment: "0xic", token_address: "0xtoken",
      amount: "100000000", nonce: "0x42", tree_id: "1",
    })
    expect(result.status).toBe("submitted")
    expect((result as { txHash?: string }).txHash).toBe("0xtx")
  })

  it("relay: POST /ipp/v1/relay (prove mode)", async () => {
    mockJsonResponse({ status: "completed", proof: "0xproof", calldata: "0xcalldata" })
    const result = await client.relay({ mode: "prove", operation: "withdraw", witness: {}, circuit: "batch_settle_1" })
    expect(result.status).toBe("completed")
    expect((result as { proof?: string }).proof).toBe("0xproof")
  })

  it("relayStatus: GET /ipp/v1/relay/{relayId}", async () => {
    mockJsonResponse({ status: "confirmed", tx_hash: "0xtx" })
    const result = await client.relayStatus("relay-123")
    expect(result.status).toBe("confirmed")
    expect(result.txHash).toBe("0xtx")
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/relay/relay-123`, expect.objectContaining({ method: "GET" }))
  })

  // === Channel ① — typed envelope errors (4xx/5xx) ===

  it("400 nested envelope → InvalidRequestError with verbatim snake fields", async () => {
    mockEnvelopeError(400, {
      type: "invalid_request_error",
      code: "invalid_argument",
      message: "payer_commitment must be bytes32",
      param: "payer_commitment",
      request_id: "req_123",
      details: { hint: "0x-prefixed 32 bytes" },
    })
    const err = await client.info({ identityCommitment: "0xbad" }).catch((e) => e)
    expect(err).toBeInstanceOf(InvalidRequestError)
    expect(err.message).toBe("payer_commitment must be bytes32")
    expect(err.type).toBe("invalid_request_error")
    expect(err.code).toBe("invalid_argument")
    expect(err.param).toBe("payer_commitment")
    expect(err.requestId).toBe("req_123") // request_id → requestId, read verbatim from envelope
    expect(err.statusCode).toBe(400)
    expect(err.details).toEqual({ hint: "0x-prefixed 32 bytes" })
    expect(err.raw.request_id).toBe("req_123") // raw keeps snake_case envelope
  })

  it("404 nested envelope → NotFoundError", async () => {
    mockEnvelopeError(404, { type: "not_found_error", code: "payment_request_not_found", message: "not found" })
    const err = await client.status("0xnope").catch((e) => e)
    expect(err).toBeInstanceOf(NotFoundError)
    expect(err.code).toBe("payment_request_not_found")
    expect(err.statusCode).toBe(404)
  })

  it("409 nested envelope → ConflictError", async () => {
    mockEnvelopeError(409, { type: "conflict_error", code: "conflict", message: "conflict" })
    const err = await client.info({ identityCommitment: "0xabc" }).catch((e) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.statusCode).toBe(409)
  })

  it("429 nested envelope → RateLimitError", async () => {
    mockEnvelopeError(429, { type: "rate_limit_error", code: "rate_limited", message: "slow down" })
    const err = await client.info({ identityCommitment: "0xabc" }).catch((e) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect(err.statusCode).toBe(429)
  })

  it("5xx nested envelope → ApiError (catch-all)", async () => {
    mockEnvelopeError(500, { type: "api_error", code: "api_error", message: "internal error" })
    const err = await client.info({ identityCommitment: "0xabc" }).catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.statusCode).toBe(500)
  })

  it("falls back to status when envelope type is missing/unknown (412 → InvalidRequestError)", async () => {
    mockEnvelopeError(412, { code: "failed_precondition", message: "request expired" })
    const err = await client.info({ identityCommitment: "0xabc" }).catch((e) => e)
    expect(err).toBeInstanceOf(InvalidRequestError)
    expect(err.code).toBe("failed_precondition")
    expect(err.statusCode).toBe(412)
  })

  // === ConnectionError — no envelope to type against (regression bug fixes) ===

  it("non-JSON error body → ConnectionError (not opaque SyntaxError)", async () => {
    mockNonJsonError(502)
    const err = await client.info({ identityCommitment: "0xabc" }).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectionError)
    expect(err).not.toBeInstanceOf(SyntaxError)
    expect(err.statusCode).toBe(502)
    // Must carry a readable message, never the "[object Object]" string coercion.
    expect(err.message).not.toContain("[object Object]")
  })

  it("error body without nested {error:{...}} shape → ConnectionError (not [object Object])", async () => {
    // The OLD flat-envelope shape `{error,message}` no longer types — it has no
    // nested object, so it cannot be coerced to a typed error nor to a string.
    mockShapelessError(400, { error: "invalid_commitment", message: "Bad commitment" })
    const err = await client.info({ identityCommitment: "0xbad" }).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectionError)
    expect(err.message).not.toContain("[object Object]")
  })

  it("empty error body → ConnectionError", async () => {
    // res.json() on an empty body rejects; treat as unparseable.
    mockNonJsonError(500)
    const err = await client.info({ identityCommitment: "0xabc" }).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectionError)
    expect(err.statusCode).toBe(500)
  })

  it("fetch rejection (network down) → ConnectionError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    const err = await client.info({ identityCommitment: "0xabc" }).catch((e) => e)
    expect(err).toBeInstanceOf(ConnectionError)
    expect(err.statusCode).toBeUndefined() // no HTTP status on a transport failure
  })

  // === Channel ② — business rejection (HTTP 200, does NOT throw) ===

  it("200 {status:rejected, reject_code} → resolves with rejectCode, does NOT throw", async () => {
    mockJsonResponse({
      status: "rejected",
      reject_code: "insufficient_credit_balance",
      reason: "draw amount exceeds remainder",
    })
    const result = await client.creditDraw({
      identityCommitment: "0xabc", tokenAddress: "0xtoken", treeId: "1",
      creditCommitments: ["0xc1"], amounts: ["50000000"],
    })
    expect(result.status).toBe("rejected")
    // reject_code → rejectCode via the success-path snake→camel codec.
    expect(result.rejectCode).toBe("insufficient_credit_balance")
    expect(result.reason).toBe("draw amount exceeds remainder")
  })

  it("authorize 200 rejected surfaces rejectCode", async () => {
    mockJsonResponse({ status: "rejected", reject_code: "no_preallocated_credential", reason: "no credential" })
    const result = await client.authorize({ identityCommitment: "0xabc", amount: "1000000", expiry: "1711900000" })
    expect(result.status).toBe("rejected")
    expect(result.rejectCode).toBe("no_preallocated_credential")
  })

  // === Channel ③ — relay async failure (HTTP 200, read errorCode from status poll) ===

  it("relayStatus 200 {status:failed, error_code} → reads errorCode, does NOT throw", async () => {
    mockJsonResponse({ status: "failed", error_code: "relay_bad_calldata", reason: "calldata not 0x-hex" })
    const result = await client.relayStatus("relay-123")
    expect(result.status).toBe("failed")
    expect(result.errorCode).toBe("relay_bad_calldata")
  })

  it("strips trailing slash from endpoint", () => {
    const c = new IPPClient("https://pay.example.com/")
    // @ts-expect-error -- access private for test
    expect(c.baseUrl).toBe(`${ENDPOINT}/ipp/v1`)
  })
})
