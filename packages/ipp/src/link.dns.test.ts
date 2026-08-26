import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { encodeIPPRequest } from "./codec"
import type { IPPRequest } from "./types"

// Rule 4 cases that need control over what a NAME resolves to. link.test.ts
// deliberately never mocks the resolver -- its rule-4 cases use address literals
// so they exercise the real code path. Here `node:dns` is replaced instead, which
// is the only way to reach three things: the fail-closed branch when the module
// cannot be loaded, the re-check that runs AFTER the response, and the attack
// rule 4 exists for (a public name whose A record points somewhere internal).
//
// Every test re-imports ./link through a fresh module graph, because the module
// memoizes its resolver. That also means the error classes must come from the
// SAME fresh graph -- a statically imported ConnectionError would be a different
// class object and `toBeInstanceOf` would fail for the wrong reason.

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

type LookupResult = Array<{ address: string; family: number }>

/** Load ./link and ./errors through a fresh graph with `node:dns` replaced. */
async function loadWithDns(factory: () => unknown) {
  vi.resetModules()
  vi.doMock("node:dns", factory)
  const link = await import("./link")
  const errors = await import("./errors")
  return { link, errors }
}

/** A `node:dns` stand-in whose promises.lookup is the given spy. */
function dnsModule(lookup: (...args: unknown[]) => Promise<LookupResult>) {
  return () => ({ promises: { lookup }, default: { promises: { lookup } } })
}

let mockFetch: ReturnType<typeof vi.fn<Parameters<typeof fetch>, Promise<Response>>>

beforeEach(() => {
  mockFetch = vi.fn<Parameters<typeof fetch>, Promise<Response>>()
})

afterEach(() => {
  vi.doUnmock("node:dns")
  vi.resetModules()
})

describe("rule 4 -- fail closed on Node", () => {
  it("throws instead of downgrading when node:dns cannot be imported", async () => {
    // A Node-targeted bundle that stubbed the runtime-assembled specifier, a
    // permission-restricted module, an Electron main-process build. Returning
    // null here would silently drop the strictest runtime to the weakest check.
    const { link } = await loadWithDns(() => {
      throw new Error("module blocked")
    })
    await expect(link.resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /"node:dns" could not be loaded/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("throws when node:dns exposes no promises.lookup", async () => {
    // Both shapes present but empty: vitest's mock namespace throws on a missing
    // `default`, which would land in the import-failed branch and hide this one.
    const { link } = await loadWithDns(() => ({ promises: {}, default: { promises: {} } }))
    await expect(link.resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /exposed no promises\.lookup/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })
})

describe("rule 4 -- the attack the rule exists for", () => {
  it("rejects a public name whose A record points at cloud metadata", async () => {
    const lookup = vi.fn(async () => [{ address: "169.254.169.254", family: 4 }])
    const { link } = await loadWithDns(dnsModule(lookup))
    await expect(link.resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /resolves to a non-public address \(169\.254\.169\.254\)/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
    expect(lookup).toHaveBeenCalledWith(HOST, { all: true, verbatim: true })
  })

  it("rejects when only one of several answers is internal", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ])
    const { link } = await loadWithDns(dnsModule(lookup))
    await expect(link.resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /resolves to a non-public address \(10\.0\.0\.5\)/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("rejects a NAT64-wrapped internal address in an AAAA answer", async () => {
    // 64:ff9b::a00:1 is 10.0.0.1 behind NAT64. A hostile resolver answering
    // AAAA is the realistic way to reach this wrapper, which is why the
    // embedded-IPv4 unwrapping has to run on resolved addresses too.
    const lookup = vi.fn(async () => [{ address: "64:ff9b::a00:1", family: 6 }])
    const { link } = await loadWithDns(dnsModule(lookup))
    await expect(link.resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /resolves to a non-public address/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("allows a name that resolves entirely to public addresses", async () => {
    const lookup = vi.fn(async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ])
    const { link } = await loadWithDns(dnsModule(lookup))
    mockFetch.mockResolvedValue(response(encodeIPPRequest(makeRequest(ENDPOINT), "json")))
    const { endpoint } = await link.resolveIPPLink(LINK, { fetch: mockFetch })
    expect(endpoint).toBe(ENDPOINT)
  })
})

describe("rule 4 -- re-check after the response", () => {
  it("refuses to hand back a body fetched while the name pointed somewhere internal", async () => {
    // fetch exposes no hook to pin the socket to the address that was checked,
    // so a name can rebind between the check and the connect. This second check
    // cannot un-send the request; it stops the response being handed to the
    // caller as a payment request. Deleting it must make this test go red.
    const lookup = vi
      .fn<unknown[], Promise<LookupResult>>()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }])
    const { link } = await loadWithDns(dnsModule(lookup))
    mockFetch.mockResolvedValue(response(encodeIPPRequest(makeRequest(ENDPOINT), "json")))

    await expect(link.resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /resolves to a non-public address \(10\.0\.0\.5\)/,
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(2)
  })

  it("does not re-check for resolveIPPLinkUnsafe", async () => {
    const lookup = vi.fn(async () => [{ address: "10.0.0.5", family: 4 }])
    const { link } = await loadWithDns(dnsModule(lookup))
    mockFetch.mockResolvedValue(response(encodeIPPRequest(makeRequest(ENDPOINT), "json")))
    await expect(link.resolveIPPLinkUnsafe(LINK, { fetch: mockFetch })).resolves.toBeDefined()
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe("rule 4 -- a lookup failure is a transport failure", () => {
  it("reports an unresolvable host as ConnectionError, not as a safety verdict", async () => {
    // Being offline is not a verdict about this host. Reporting it as one has
    // the wallet tell the user "refused to resolve", which reads as "this code
    // is dangerous" rather than "you have no network".
    const lookup = vi.fn(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" })
    })
    const { link, errors } = await loadWithDns(dnsModule(lookup as never))
    const err = await link.resolveIPPLink(LINK, { fetch: mockFetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(errors.ConnectionError)
    expect((err as Error).message).not.toMatch(/Refusing/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("reports an empty answer as ConnectionError too", async () => {
    const lookup = vi.fn(async () => [] as LookupResult)
    const { link, errors } = await loadWithDns(dnsModule(lookup))
    const err = await link.resolveIPPLink(LINK, { fetch: mockFetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(errors.ConnectionError)
  })
})
