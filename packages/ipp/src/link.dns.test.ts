import { describe, it, expect, vi, beforeEach } from "vitest"
import { encodeIPPRequest } from "./codec"
import { resolveIPPLink } from "./link"
import { ConnectionError } from "./errors"
import type { HostResolver } from "./link"
import type { IPPRequest } from "./types"

// Rule 4 cases that need control over what a NAME resolves to. link.test.ts
// deliberately never passes a resolver -- its rule-4 cases use address literals
// so they exercise the spelling path. Here a resolver is injected instead, which
// is the only way to reach two things: the re-check that runs AFTER the response,
// and the attack rule 4 exists for (a public name whose A record points inside).

const HOST = "pay.example.com"
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv"
const ENDPOINT = `https://${HOST}`
const LINK = `${ENDPOINT}/ipp/v1/link/${TOKEN}`

function makeRequest(endpoint: string): IPPRequest {
  return {
    v: 1,
    network: "eip155:84532",
    type: "request",
    payload: {
      identityCommitment: "0x1111111111111111111111111111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      operator: "0x3333333333333333333333333333333333333333",
      paymentTypes: ["open"],
      mode: "multi",
      endpoint,
    },
  }
}

function response(body: string): Response {
  const bytes = new TextEncoder().encode(body)
  return {
    ok: true,
    status: 200,
    type: "basic",
    headers: new Headers(),
    body: null,
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(bytes.buffer),
  } as unknown as Response
}

let mockFetch: ReturnType<typeof vi.fn<Parameters<typeof fetch>, Promise<Response>>>

beforeEach(() => {
  mockFetch = vi.fn<Parameters<typeof fetch>, Promise<Response>>()
})

describe("rule 4 -- the attack the rule exists for", () => {
  it("rejects a public name whose A record points at cloud metadata", async () => {
    const hostResolver = vi.fn<[string], Promise<string[]>>(async () => ["169.254.169.254"])
    await expect(resolveIPPLink(LINK, { fetch: mockFetch, hostResolver })).rejects.toThrow(
      /resolves to a non-public address \(169\.254\.169\.254\)/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
    expect(hostResolver).toHaveBeenCalledWith(HOST)
  })

  it("rejects when only one of several answers is internal", async () => {
    const hostResolver: HostResolver = async () => ["93.184.216.34", "10.0.0.5"]
    await expect(resolveIPPLink(LINK, { fetch: mockFetch, hostResolver })).rejects.toThrow(
      /resolves to a non-public address \(10\.0\.0\.5\)/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects a NAT64-wrapped internal address in an AAAA answer", async () => {
    // 64:ff9b::a00:1 is 10.0.0.1 behind NAT64. A hostile resolver answering
    // AAAA is the realistic way to reach this wrapper, which is why the
    // embedded-IPv4 unwrapping has to run on resolved addresses too.
    const hostResolver: HostResolver = async () => ["64:ff9b::a00:1"]
    await expect(resolveIPPLink(LINK, { fetch: mockFetch, hostResolver })).rejects.toThrow(
      /resolves to a non-public address/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("allows a name that resolves entirely to public addresses", async () => {
    const hostResolver: HostResolver = async () => ["93.184.216.34", "2606:2800:220:1::1"]
    mockFetch.mockResolvedValue(response(encodeIPPRequest(makeRequest(ENDPOINT), "json")))
    const { endpoint } = await resolveIPPLink(LINK, { fetch: mockFetch, hostResolver })
    expect(endpoint).toBe(ENDPOINT)
  })
})

describe("rule 4 -- without a resolver the check is only as strong as the spelling", () => {
  it("lets a public name through without asking where it points", async () => {
    // The documented cost of not passing `hostResolver`: browsers have no name
    // resolution to pass, so this is the browser's permanent state, and a Node
    // caller that skips `nodeHostResolver` opts into the same weaker check.
    // Deleting the resolver plumbing must NOT be able to keep the suite green:
    // the cases above are what notice, which is why they inject one.
    mockFetch.mockResolvedValue(response(encodeIPPRequest(makeRequest(ENDPOINT), "json")))
    const { endpoint } = await resolveIPPLink(LINK, { fetch: mockFetch })
    expect(endpoint).toBe(ENDPOINT)
  })

  it("still refuses a name that says out loud it is local", async () => {
    const local = "http://box.local/ipp/v1/link/" + TOKEN
    await expect(resolveIPPLink(local.replace("http:", "https:"), { fetch: mockFetch })).rejects.toThrow(
      /names the local machine or local network/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe("rule 4 -- re-check after the response", () => {
  it("refuses to hand back a body fetched while the name pointed somewhere internal", async () => {
    // fetch exposes no hook to pin the socket to the address that was checked,
    // so a name can rebind between the check and the connect. This second check
    // cannot un-send the request; it stops the response being handed to the
    // caller as a payment request. Deleting it must make this test go red.
    const hostResolver = vi
      .fn<[string], Promise<string[]>>()
      .mockResolvedValueOnce(["93.184.216.34"])
      .mockResolvedValueOnce(["10.0.0.5"])
    mockFetch.mockResolvedValue(response(encodeIPPRequest(makeRequest(ENDPOINT), "json")))

    await expect(resolveIPPLink(LINK, { fetch: mockFetch, hostResolver })).rejects.toThrow(
      /resolves to a non-public address \(10\.0\.0\.5\)/,
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(hostResolver).toHaveBeenCalledTimes(2)
  })

  it("does not re-check when allowInsecureTransport is set", async () => {
    const hostResolver = vi.fn<[string], Promise<string[]>>(async () => ["10.0.0.5"])
    mockFetch.mockResolvedValue(response(encodeIPPRequest(makeRequest(ENDPOINT), "json")))
    await expect(
      resolveIPPLink(LINK, { fetch: mockFetch, hostResolver, allowInsecureTransport: true }),
    ).resolves.toBeDefined()
    expect(hostResolver).not.toHaveBeenCalled()
  })
})

describe("rule 4 -- a lookup failure is a transport failure", () => {
  it("reports an unresolvable host as ConnectionError, not as a safety verdict", async () => {
    // Being offline is not a verdict about this host. Reporting it as one has
    // the wallet tell the user "refused to resolve", which reads as "this code
    // is dangerous" rather than "you have no network".
    const hostResolver: HostResolver = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
    }
    const err = await resolveIPPLink(LINK, { fetch: mockFetch, hostResolver }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ConnectionError)
    expect((err as Error).message).not.toMatch(/Refusing/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("reports an empty answer as ConnectionError too", async () => {
    const hostResolver: HostResolver = async () => []
    const err = await resolveIPPLink(LINK, { fetch: mockFetch, hostResolver }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ConnectionError)
  })
})
