import { describe, it, expect, vi, beforeEach } from "vitest"
import { IPPClient } from "./client"

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

function mockErrorResponse(status: number, data: { error: string; message?: string }) {
  mockFetch.mockResolvedValueOnce({
    ok: false,
    status,
    json: () => Promise.resolve(data),
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
    const result = await client.authorize({ identityCommitment: "0xabc", amount: "1000000", expiry: "1711900000" })
    expect(sentBody()).toEqual({ identity_commitment: "0xabc", amount: "1000000", expiry: "1711900000" })
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

  it("throws on HTTP error — error envelope stays snake, not transcoded", async () => {
    mockErrorResponse(400, { error: "invalid_commitment", message: "Bad commitment" })
    await expect(client.info({ identityCommitment: "0xbad" })).rejects.toThrow("invalid_commitment")
  })

  it("strips trailing slash from endpoint", () => {
    const c = new IPPClient("https://pay.example.com/")
    // @ts-expect-error -- access private for test
    expect(c.baseUrl).toBe(`${ENDPOINT}/ipp/v1`)
  })
})
