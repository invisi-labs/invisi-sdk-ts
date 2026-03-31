import { describe, it, expect, vi, beforeEach } from "vitest"
import { IPPClient } from "./client"
import type {
  InfoResponse,
  ProposeResponse,
  AuthorizeResponse,
  StatusResponse,
  NotifyResponse,
  WithdrawResponse,
  CreditDrawResponse,
  CreditReclaimResponse,
  CreditStatusResponse,
  RelayResponse,
  RelayProveResponse,
  RelayStatusResponse,
} from "./interaction-types"

const ENDPOINT = "https://pay.example.com"
const BASE_URL = `${ENDPOINT}/ipp/v1`

const mockFetch = vi.fn()
globalThis.fetch = mockFetch

function mockJsonResponse<T>(data: T) {
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

beforeEach(() => {
  vi.clearAllMocks()
})

describe("IPPClient", () => {
  const client = new IPPClient(ENDPOINT)

  it("info: POST /ipp/v1/info", async () => {
    const resp: InfoResponse = { merchantName: "Coffee Shop", amount: "100000000" }
    mockJsonResponse(resp)
    const result = await client.info({ identityCommitment: "0xabc" })
    expect(result).toEqual(resp)
    expect(mockFetch).toHaveBeenCalledWith(
      `${BASE_URL}/info`,
      expect.objectContaining({ method: "POST" }),
    )
  })

  it("propose: POST /ipp/v1/propose", async () => {
    const resp: ProposeResponse = { status: "accepted", nonce: "0x42", paymentCommitment: "0xdef" }
    mockJsonResponse(resp)
    const result = await client.propose({ identityCommitment: "0xabc", amount: "100000000" })
    expect(result.status).toBe("accepted")
    expect(result.nonce).toBe("0x42")
  })

  it("authorize: POST /ipp/v1/authorize", async () => {
    const resp: AuthorizeResponse = { status: "accepted", nonce: "0x42", creditCommitment: "0xccc", nullifierKeyHash: "0xnkh" }
    mockJsonResponse(resp)
    const result = await client.authorize({ identityCommitment: "0xabc", amount: "1000000", expiry: "1711900000" })
    expect(result.status).toBe("accepted")
    expect(result.creditCommitment).toBe("0xccc")
  })

  it("status: GET /ipp/v1/status/{paymentCommitment}", async () => {
    const resp: StatusResponse = { status: "confirmed", txHash: "0xtx" }
    mockJsonResponse(resp)
    const result = await client.status("0xpayment")
    expect(result.status).toBe("confirmed")
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/status/0xpayment`, expect.objectContaining({ method: "GET" }))
  })

  it("notify: POST /ipp/v1/notify", async () => {
    const resp: NotifyResponse = { received: true }
    mockJsonResponse(resp)
    const result = await client.notify({ paymentCommitment: "0xp", txHash: "0xtx", network: "eip155:84532" })
    expect(result.received).toBe(true)
  })

  it("withdraw: POST /ipp/v1/withdraw", async () => {
    const resp: WithdrawResponse = {
      status: "accepted",
      witness: { merkleRoot: "0xroot", nullifiers: ["0xn1"], totalAmount: "100000000", receivingAddress: "0xaddr", merkleProofs: [] },
      circuit: "batch_settle_1",
    }
    mockJsonResponse(resp)
    const result = await client.withdraw({ identityCommitment: "0xabc", tokenAddress: "0xtoken", treeId: "1", paymentCommitments: ["0xp1"] })
    expect(result.status).toBe("accepted")
    expect(result.circuit).toBe("batch_settle_1")
  })

  it("creditDraw: POST /ipp/v1/credit-draw", async () => {
    const resp: CreditDrawResponse = { status: "accepted", circuit: "credit_draw_1" }
    mockJsonResponse(resp)
    const result = await client.creditDraw({ identityCommitment: "0xabc", tokenAddress: "0xtoken", treeId: "1", creditCommitments: ["0xc1"], amounts: ["50000000"] })
    expect(result.status).toBe("accepted")
  })

  it("creditReclaim: POST /ipp/v1/credit-reclaim", async () => {
    const resp: CreditReclaimResponse = { status: "accepted", circuit: "credit_reclaim" }
    mockJsonResponse(resp)
    const result = await client.creditReclaim({ creditCommitment: "0xcc", tokenAddress: "0xtoken", treeId: "1" })
    expect(result.status).toBe("accepted")
  })

  it("creditStatus: GET /ipp/v1/credit/{creditCommitment}", async () => {
    const resp: CreditStatusResponse = {
      status: "active", originalAmount: "1000000", drawnAmount: "500000", remainderAmount: "500000",
      expiry: "1711900000", draws: [{ amount: "500000", timestamp: "1711800000", txHash: "0xtx" }],
    }
    mockJsonResponse(resp)
    const result = await client.creditStatus("0xcc")
    expect(result.status).toBe("active")
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/credit/0xcc`, expect.objectContaining({ method: "GET" }))
  })

  it("relay: POST /ipp/v1/relay (signature mode)", async () => {
    const resp: RelayResponse = { status: "submitted", txHash: "0xtx" }
    mockJsonResponse(resp)
    const result = await client.relay({
      mode: "signature", operation: "pay-open", network: "eip155:84532", signature: "0xsig",
      paymentCommitment: "0xpc", identityCommitment: "0xic", tokenAddress: "0xtoken",
      amount: "100000000", nonce: "0x42", treeId: "1",
    })
    expect(result.status).toBe("submitted")
  })

  it("relay: POST /ipp/v1/relay (prove mode)", async () => {
    const resp: RelayProveResponse = { status: "completed", proof: "0xproof", calldata: "0xcalldata" }
    mockJsonResponse(resp)
    const result = await client.relay({ mode: "prove", operation: "withdraw", witness: {}, circuit: "batch_settle_1" })
    expect((result as RelayProveResponse).proof).toBe("0xproof")
  })

  it("relayStatus: GET /ipp/v1/relay/{relayId}", async () => {
    const resp: RelayStatusResponse = { status: "confirmed", txHash: "0xtx" }
    mockJsonResponse(resp)
    const result = await client.relayStatus("relay-123")
    expect(result.status).toBe("confirmed")
    expect(mockFetch).toHaveBeenCalledWith(`${BASE_URL}/relay/relay-123`, expect.objectContaining({ method: "GET" }))
  })

  it("throws on HTTP error", async () => {
    mockErrorResponse(400, { error: "invalid_commitment", message: "Bad commitment" })
    await expect(client.info({ identityCommitment: "0xbad" })).rejects.toThrow("invalid_commitment")
  })

  it("strips trailing slash from endpoint", () => {
    const c = new IPPClient("https://pay.example.com/")
    // @ts-expect-error -- access private for test
    expect(c.baseUrl).toBe(`${ENDPOINT}/ipp/v1`)
  })
})
