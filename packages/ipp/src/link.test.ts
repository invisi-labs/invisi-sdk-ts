import { describe, it, expect, vi, beforeEach } from "vitest"
import { resolveIPPLink, resolveIPPLinkUnsafe } from "./link"
import { encodeIPPRequest, decodeIPPRequest } from "./codec"
import { NotFoundError, InvalidRequestError, ConnectionError } from "./errors"
import type { IPPRequest } from "./types"

// A public literal address is used as the happy-path host on purpose: literal
// addresses skip name resolution, so the suite never touches DNS or the network.
// The one case that must exercise resolution uses "localhost", which every
// platform answers from its own hosts file.
const PUBLIC_HOST = "203.0.113.10"
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv"
const ENDPOINT = `https://${PUBLIC_HOST}`
const LINK = `${ENDPOINT}/ipp/v1/link/${TOKEN}`

/**
 * Build a string from code points.
 *
 * W7: an invisible character written literally into this file is one an editor
 * or formatter that normalizes Unicode will silently delete -- and every one of
 * them lives in a MUST-REJECT case, so the deletion leaves the suite green and
 * the rule unprotected. Never type one; construct it.
 */
const cp = (...codes: number[]): string => String.fromCodePoint(...codes)

function makeRequest(endpoint: string): IPPRequest {
  return {
    v: 1,
    network: "eip155:84532",
    type: "request",
    meta: { merchantName: "Coffee Shop", orderId: "A-1" },
    payload: {
      identityCommitment: "0x1111111111111111111111111111111111111111111111111111111111111111",
      tokenAddress: "0x2222222222222222222222222222222222222222",
      operator: "0x3333333333333333333333333333333333333333",
      paymentTypes: ["open", "blind"],
      mode: "multi",
      endpoint,
    },
  }
}

function jsonBody(endpoint: string): string {
  return encodeIPPRequest(makeRequest(endpoint), "json")
}

/**
 * A mocked response. The body may be given as BYTES, which is the only way to
 * exercise the leading-byte rules -- handing the resolver an already-decoded
 * string skips the layer where a BOM is stripped, which is exactly the layer
 * under test.
 */
function response(
  body: string | Uint8Array,
  init?: { status?: number; type?: string; headers?: Record<string, string> },
): Response {
  const status = init?.status ?? 200
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  return {
    ok: status >= 200 && status < 300,
    status,
    type: init?.type ?? "basic",
    headers: new Headers(init?.headers),
    body: null,
    text: () => Promise.resolve(new TextDecoder().decode(bytes)),
    arrayBuffer: () =>
      Promise.resolve(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ),
  } as unknown as Response
}

/** Response whose body is a real stream, so the byte cap is metered while reading. */
function streamedResponse(body: string): Response {
  const bytes = new TextEncoder().encode(body)
  return {
    ok: true,
    status: 200,
    type: "basic",
    headers: new Headers(),
    text: () => Promise.resolve(body),
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 8) {
          controller.enqueue(bytes.slice(i, i + 8))
        }
        controller.close()
      },
    }),
  } as unknown as Response
}

type FetchMock = ReturnType<typeof newFetchMock>

function newFetchMock() {
  return vi.fn<Parameters<typeof fetch>, Promise<Response>>()
}

let mockFetch: FetchMock

beforeEach(() => {
  mockFetch = newFetchMock()
})

function ok(endpoint = ENDPOINT) {
  mockFetch.mockResolvedValueOnce(response(jsonBody(endpoint)))
}

// ---------------------------------------------------------------------------
// Rule 1 -- shape match, and no request is issued when it fails
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- rule 1: shape match happens before any request", () => {
  const rejected: Array<[string, string]> = [
    ["plain http", `http://${PUBLIC_HOST}/ipp/v1/link/${TOKEN}`],
    ["non-http scheme", `ftp://${PUBLIC_HOST}/ipp/v1/link/${TOKEN}`],
    ["ipp1 compact string", "ipp1:gaR0eXBlp3JlcXVlc3Q"],
    ["token too short", `${ENDPOINT}/ipp/v1/link/${TOKEN.slice(0, 21)}`],
    ["token too long", `${ENDPOINT}/ipp/v1/link/${TOKEN}x`],
    ["token has non-base64url char", `${ENDPOINT}/ipp/v1/link/AbCdEfGhIjKlMnOpQrSt+v`],
    ["wrong protocol version segment", `${ENDPOINT}/ipp/v2/link/${TOKEN}`],
    ["missing /ipp/v1 prefix", `${ENDPOINT}/link/${TOKEN}`],
    ["trailing slash after token", `${ENDPOINT}/ipp/v1/link/${TOKEN}/`],
    ["no path at all", ENDPOINT],
    ["empty string", ""],
    ["whitespace smuggled into the URL", `${ENDPOINT}/ipp/v1/link/${TOKEN}\n`],
  ]

  for (const [name, url] of rejected) {
    it(`rejects ${name} without calling fetch`, async () => {
      await expect(resolveIPPLink(url, { fetch: mockFetch })).rejects.toThrow(/Invalid IPP link/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  // The enumerated whitespace/control set, member by member. This is the guard
  // for a property that used to be derived: the set was `\s` plus explicit
  // ranges, and `\s` is defined by the engine's Unicode version. It was
  // provably non-deciding -- every engine-dependent member is also refused by
  // the ASCII-only rule or by pchar -- but "provably" rested on those two rules
  // staying in place, with nothing red if either were relaxed. Now the set is
  // the enumeration, and each member is pinned by the reason it produces.
  const controlSetMembers: Array<[string, number]> = [
    ["NUL", 0x00],
    ["HTAB", 0x09],
    ["LF", 0x0a],
    ["CR", 0x0d],
    ["C0 upper bound", 0x1f],
    ["SPACE", 0x20],
    ["DEL", 0x7f],
    ["C1 lower bound", 0x80],
    ["NEL", 0x85],
    ["C1 upper bound", 0x9f],
    ["NBSP", 0xa0],
    ["OGHAM SPACE MARK", 0x1680],
    ["EN QUAD", 0x2000],
    ["HAIR SPACE", 0x200a],
    ["LINE SEPARATOR", 0x2028],
    ["PARAGRAPH SEPARATOR", 0x2029],
    ["NARROW NBSP", 0x202f],
    ["MEDIUM MATHEMATICAL SPACE", 0x205f],
    ["IDEOGRAPHIC SPACE", 0x3000],
    ["BOM", 0xfeff],
  ]
  for (const [name, code] of controlSetMembers) {
    it(`refuses U+${code.toString(16).toUpperCase().padStart(4, "0")} (${name}) as a set member`, async () => {
      await expect(
        resolveIPPLink(`${ENDPOINT}/a${cp(code)}b/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).rejects.toThrow(/whitespace or control characters/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  const notInTheSet: Array<[string, number]> = [
    // U+180E was Zs through Unicode 6.2 and is not any more, so an engine's
    // whitespace class answers differently depending on which version it ships.
    // It is deliberately NOT a member: refused, but by pchar, not by this set.
    ["MONGOLIAN VOWEL SEPARATOR", 0x180e],
    ["HYPHEN U+2010", 0x2010],
    ["ZWSP U+200B", 0x200b],
  ]
  for (const [name, code] of notInTheSet) {
    it(`refuses U+${code.toString(16).toUpperCase().padStart(4, "0")} (${name}) but not as a set member`, async () => {
      const message = await resolveIPPLink(`${ENDPOINT}/a${cp(code)}b/ipp/v1/link/${TOKEN}`, {
        fetch: mockFetch,
      }).then(
        () => "ACCEPTED",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      expect(message).toMatch(/must contain only RFC 3986 pchar/)
      expect(message).not.toMatch(/whitespace or control characters/)
    })
  }

  it("names control characters as the reason, C0 / DEL / C1 alike", async () => {
    // Each of these is also caught by the normal-form check, so asserting only
    // "rejected" would stay green with the character class gutted -- and Go, which
    // has no folding to trip, would then accept what we reject. Pin the reason.
    //
    // C1 is in the set because Go's unicode.IsSpace counts U+0085 (NEL) as space
    // while JavaScript's \s does not.
    const chars: Array<[string, string]> = [
      ["C0", cp(0x01)],
      ["DEL", cp(0x7f)],
      ["C1 lower bound U+0080", cp(0x80)],
      ["C1 NEL U+0085", cp(0x85)],
      ["C1 upper bound U+009F", cp(0x9f)],
      ["BOM U+FEFF", cp(0xfeff)],
    ]
    for (const [, ch] of chars) {
      await expect(
        resolveIPPLink(`${ENDPOINT}/ipp/v1/link/${TOKEN}${ch}`, { fetch: mockFetch }),
      ).rejects.toThrow(/whitespace or control characters/)
    }
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("accepts the base64url characters '-' and '_' inside the token", async () => {
    // A real CSPRNG token hits these roughly every other code; a token charset
    // narrower than base64url silently rejects a large share of live links.
    const token = "ab-cd_efGHij-klMN_op12"
    expect(token).toHaveLength(22)
    mockFetch.mockResolvedValueOnce(response(jsonBody(ENDPOINT)))
    const { endpoint } = await resolveIPPLink(`${ENDPOINT}/ipp/v1/link/${token}`, {
      fetch: mockFetch,
    })
    expect(endpoint).toBe(ENDPOINT)
  })

  it("accepts a hyphenated host name", async () => {
    // Unsafe variant keeps this off a resolver; the URL parsing it exercises is
    // shared with resolveIPPLink. "api-test.<domain>" is the deployed shape.
    mockFetch.mockResolvedValueOnce(response(jsonBody("https://api-test.invisipay.fi")))
    const { endpoint } = await resolveIPPLinkUnsafe(
      `https://api-test.invisipay.fi/ipp/v1/link/${TOKEN}`,
      { fetch: mockFetch },
    )
    expect(endpoint).toBe("https://api-test.invisipay.fi")
  })

  it("accepts a link whose endpoint carries a path prefix", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody(`${ENDPOINT}/api`)))
    const { endpoint } = await resolveIPPLink(`${ENDPOINT}/api/ipp/v1/link/${TOKEN}`, {
      fetch: mockFetch,
    })
    expect(endpoint).toBe(`${ENDPOINT}/api`)
  })
})

// ---------------------------------------------------------------------------
// Rule 2 -- URL normalization is a wire rule
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- rule 2: URL normalization", () => {
  const rejected: Array<[string, string]> = [
    // The named attack: the derived endpoint is "good.com@evil.com", which the
    // attacker controls on both sides so the cross-check passes, while the
    // confirmation screen reads as good.com.
    ["userinfo host confusion", `https://good.com@evil.com/ipp/v1/link/${TOKEN}`],
    ["userinfo with password", `https://user:pw@${PUBLIC_HOST}/ipp/v1/link/${TOKEN}`],
    ["query string", `${LINK}?fmt=json`],
    ["bare question mark", `${LINK}?`],
    ["fragment", `${LINK}#top`],
    ["bare hash", `${LINK}#`],
    ["dot segments in path", `${ENDPOINT}/a/../ipp/v1/link/${TOKEN}`],
    ["single dot segment", `${ENDPOINT}/a/./ipp/v1/link/${TOKEN}`],
    ["percent-encoded dot segments", `${ENDPOINT}/a/%2e%2e/ipp/v1/link/${TOKEN}`],
    ["mixed-spelling dot segment", `${ENDPOINT}/a/.%2E/ipp/v1/link/${TOKEN}`],
    ["double slash in path", `${ENDPOINT}//ipp/v1/link/${TOKEN}`],
    // WHATWG reads this backslash as a path separator (host becomes 203.0.113.10)
    // while Go's url.Parse keeps it in the host -- one written link, two origins.
    ["backslash in the authority", `https://${PUBLIC_HOST}\\evil.example/ipp/v1/link/${TOKEN}`],
  ]

  for (const [name, url] of rejected) {
    it(`rejects ${name} without calling fetch`, async () => {
      await expect(resolveIPPLink(url, { fetch: mockFetch })).rejects.toThrow(/Invalid IPP link/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  it("names the backslash and the dot segment as the reason, not just 'invalid'", async () => {
    // These two also trip the "path is not in normal form" check, so without
    // pinning the message a future refactor could drop the explicit rules and
    // still look green -- while Go, which has no folding to trip, would accept them.
    await expect(
      resolveIPPLink(`https://${PUBLIC_HOST}\\evil.example/ipp/v1/link/${TOKEN}`, {
        fetch: mockFetch,
      }),
    ).rejects.toThrow(/must not contain a backslash/)
    await expect(
      resolveIPPLink(`${ENDPOINT}/a/%2e%2e/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/must not contain "\." or "\.\." segments/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("drops the scheme default port when deriving the endpoint", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody(ENDPOINT)))
    const { endpoint } = await resolveIPPLink(`https://${PUBLIC_HOST}:443/ipp/v1/link/${TOKEN}`, {
      fetch: mockFetch,
    })
    expect(endpoint).toBe(ENDPOINT)
  })

  it("keeps a non-default port in the derived endpoint", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody(`https://${PUBLIC_HOST}:8443`)))
    const { endpoint } = await resolveIPPLink(`https://${PUBLIC_HOST}:8443/ipp/v1/link/${TOKEN}`, {
      fetch: mockFetch,
    })
    expect(endpoint).toBe(`https://${PUBLIC_HOST}:8443`)
  })

  it("lowercases the host on both sides of the cross-check", async () => {
    // Host case is accepted and normalized -- DNS is case-insensitive and
    // payload.endpoint may legitimately arrive uppercased. Scheme case is not;
    // see the pair of cases below.
    mockFetch.mockResolvedValueOnce(response(jsonBody("http://LocalHost:3000")))
    const { endpoint } = await resolveIPPLinkUnsafe(
      `http://LOCALHOST:3000/ipp/v1/link/${TOKEN}`,
      { fetch: mockFetch },
    )
    expect(endpoint).toBe("http://localhost:3000")
  })

  it("refuses an uppercase scheme instead of normalizing it", async () => {
    // RFC 3986 makes a scheme case-insensitive, so "normalize it" and "require
    // the literal" are both readings of a rule that only names `https` -- and
    // the two readings give opposite answers for this URL. Every other spelling
    // on this wire is refused rather than normalized; the scheme is not the one
    // exception. The host case above is the deliberate asymmetry.
    for (const scheme of ["HTTPS", "Https", "hTTps"]) {
      await expect(
        resolveIPPLink(`${scheme}://${PUBLIC_HOST}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).rejects.toThrow(/scheme must be the lowercase literal/)
    }
    await expect(
      resolveIPPLinkUnsafe(`HTTP://${PUBLIC_HOST}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/scheme must be the lowercase literal/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("refuses an uppercase scheme in payload.endpoint too", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody(`HTTPS://${PUBLIC_HOST}`)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /payload\.endpoint: scheme must be the lowercase literal/,
    )
  })
})

// ---------------------------------------------------------------------------
// Rule 4 -- loopback / private / link-local, judged on the resolved address
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- rule 4: private network targets", () => {
  const blocked: Array<[string, string]> = [
    ["IPv4 loopback", "127.0.0.1"],
    ["RFC 1918 10/8", "10.1.2.3"],
    ["RFC 1918 172.16/12", "172.20.0.5"],
    ["RFC 1918 192.168/16", "192.168.1.1"],
    ["link-local / cloud metadata", "169.254.169.254"],
    ["unspecified", "0.0.0.0"],
    ["IETF protocol assignments 192.0.0.0/24", "192.0.0.1"],
    ["CGNAT lower bound", "100.64.0.1"],
    ["CGNAT upper bound", "100.127.255.255"],
    ["IPv6 loopback", "[::1]"],
    ["IPv6 link-local", "[fe80::1]"],
    ["IPv6 unique local", "[fc00::abcd]"],
    // Each written in ITS canonical form, so what these pin is the address
    // range and not a spelling. RFC 5952 section 5 gives v4-mapped the mixed
    // notation and gives nothing else a dotted tail, hence the split: mixed
    // here for ::ffff:, pure hex here for ::/96 and NAT64.
    ["IPv4-mapped IPv6 loopback", "[::ffff:127.0.0.1]"],
    ["IPv4-mapped IPv6 cloud metadata", "[::ffff:169.254.169.254]"],
    ["IPv4-compatible IPv6 loopback", "[::7f00:1]"],
    ["NAT64-wrapped loopback", "[64:ff9b::7f00:1]"],
    ["NAT64-wrapped RFC 1918", "[64:ff9b::a00:1]"],
  ]

  for (const [name, host] of blocked) {
    it(`rejects ${name} without calling fetch`, async () => {
      await expect(
        resolveIPPLink(`https://${host}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).rejects.toThrow(/loopback \/ private \/ link-local/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  it("judges a name by the address it resolves to, not by the name itself", async () => {
    // "localhost" is not an address literal, so reaching a verdict here requires
    // the resolver to have run -- the error names the address it came back with.
    await expect(
      resolveIPPLink(`https://localhost/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/resolves to a non-public address \((127\.0\.0\.1|::1)\)/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("treats 192.0.2.0/24 (TEST-NET-1) as public, so 192.0.0.0/24 stays a /24", async () => {
    // The reject list is 192.0.0.0/24, not 192.0/16. Widening it swallows
    // TEST-NET-1, which the Go implementation lets through -- and a reject list
    // that differs between the two SDKs is a code that pays in one wallet and
    // not in the other. Without this assertion, "simplifying" the third-octet
    // check away turns nothing red.
    for (const host of ["192.0.2.1", "192.0.1.1", "192.0.255.255"]) {
      mockFetch.mockResolvedValueOnce(response(jsonBody(`https://${host}`)))
      await expect(
        resolveIPPLink(`https://${host}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).resolves.toBeDefined()
    }
  })

  it("treats the addresses just outside 100.64.0.0/10 as public", async () => {
    // The CGNAT test is the only rule-4 range whose bounds are not a whole
    // octet, so an off-by-one in the second-octet comparison is the realistic
    // way to get it wrong -- in either direction.
    for (const host of ["100.63.255.255", "100.128.0.0"]) {
      mockFetch.mockResolvedValueOnce(response(jsonBody(`https://${host}`)))
      await expect(
        resolveIPPLink(`https://${host}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).resolves.toBeDefined()
    }
  })

  it("allows a public address literal", async () => {
    ok()
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Rule 6 -- redirects are never followed
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- rule 6: no redirect following", () => {
  for (const status of [301, 302, 303, 307, 308]) {
    it(`fails on HTTP ${status}`, async () => {
      mockFetch.mockResolvedValueOnce(response("", { status }))
      await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
        /refused to follow a redirect/,
      )
    })
  }

  it("fails on a browser opaque-redirect response", async () => {
    mockFetch.mockResolvedValueOnce(response("", { status: 0, type: "opaqueredirect" }))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /refused to follow a redirect \(opaque redirect response\)/,
    )
  })

  it("names the status it actually saw instead of inventing one", async () => {
    mockFetch.mockResolvedValueOnce(response("", { status: 307 }))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(/HTTP 307/)
  })

  it("reports a status-0 response that is not an opaque redirect as a transport failure", async () => {
    // Status 0 with no opaqueredirect marker means CORS or an extension blocked
    // the response. Calling that "refused to follow a redirect" would state a
    // cause we cannot distinguish, and would send the user hunting the wrong bug.
    mockFetch.mockResolvedValueOnce(response("", { status: 0, type: "opaque" }))
    const err = await resolveIPPLink(LINK, { fetch: mockFetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConnectionError)
    expect((err as Error).message).not.toMatch(/redirect/)
  })

  it("asks fetch not to follow redirects in the first place", async () => {
    ok()
    await resolveIPPLink(LINK, { fetch: mockFetch })
    expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" })
  })
})

// ---------------------------------------------------------------------------
// Rule 9 -- endpoint cross-check
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- rule 9: endpoint cross-check", () => {
  it("accepts a payload endpoint equal to the derived one", async () => {
    ok()
    const { endpoint, request } = await resolveIPPLink(LINK, { fetch: mockFetch })
    expect(endpoint).toBe(ENDPOINT)
    expect(request.payload.endpoint).toBe(ENDPOINT)
  })

  it("accepts a payload endpoint that differs only by a trailing slash", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody(`${ENDPOINT}/`)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
  })

  it("rejects a payload endpoint on a different host", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody("https://evil.example")))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /endpoint mismatch/,
    )
  })

  it("rejects a payload endpoint on a different port", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody(`${ENDPOINT}:8443`)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(/endpoint mismatch/)
  })

  it("rejects a payload endpoint carrying userinfo, naming userinfo as the reason", async () => {
    // Reported as a malformed endpoint rather than as a mismatch: the two are
    // different facts, and only the specific message proves the wire-form rules
    // ran on this side at all.
    mockFetch.mockResolvedValueOnce(response(jsonBody(`https://x@${PUBLIC_HOST}`)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /payload\.endpoint: URL must not contain userinfo/,
    )
  })

  it("reports a missing payload endpoint as missing, not as a mismatch", async () => {
    const msg = JSON.parse(jsonBody(ENDPOINT)) as Record<string, unknown>
    delete (msg["payload"] as Record<string, unknown>)["endpoint"]
    mockFetch.mockResolvedValueOnce(response(JSON.stringify(msg)))
    // validateIPPRequest fires first for mode multi, which is the stronger
    // statement; either way it never reaches the comparison.
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(/endpoint is required/)
  })

  it("accepts a payload endpoint of \"https://h//\" -- strip trailing slashes, then check segments", async () => {
    // W2 pins this order. Reversed, the empty segment is refused and a legal
    // endpoint stops matching; the order itself has to agree across implementations.
    mockFetch.mockResolvedValueOnce(response(jsonBody(`${ENDPOINT}//`)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Unsafe variant -- the only door to http and private targets
// ---------------------------------------------------------------------------

describe("resolveIPPLinkUnsafe", () => {
  const localLink = `http://127.0.0.1:8080/ipp/v1/link/${TOKEN}`
  const localEndpoint = "http://127.0.0.1:8080"

  it("resolves an http link on loopback", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody(localEndpoint)))
    const { endpoint } = await resolveIPPLinkUnsafe(localLink, { fetch: mockFetch })
    expect(endpoint).toBe(localEndpoint)
  })

  it("resolves an https link on a CGNAT address", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody("https://100.64.0.1")))
    await expect(
      resolveIPPLinkUnsafe(`https://100.64.0.1/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).resolves.toBeDefined()
  })

  it("resolves an https link on a private address", async () => {
    mockFetch.mockResolvedValueOnce(response(jsonBody("https://192.168.1.9")))
    await expect(
      resolveIPPLinkUnsafe(`https://192.168.1.9/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).resolves.toBeDefined()
  })

  it("is the only variant that accepts them -- resolveIPPLink rejects the same links", async () => {
    await expect(resolveIPPLink(localLink, { fetch: mockFetch })).rejects.toThrow(
      /scheme must be the lowercase literal "https"/,
    )
    await expect(
      resolveIPPLink(`https://192.168.1.9/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/loopback \/ private \/ link-local/)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("still enforces shape, normalization and the cross-check", async () => {
    await expect(
      resolveIPPLinkUnsafe(`http://good.com@127.0.0.1/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/must not contain userinfo/)
    await expect(
      resolveIPPLinkUnsafe(`http://127.0.0.1/ipp/v1/link/short`, { fetch: mockFetch }),
    ).rejects.toThrow(/Invalid IPP link/)
    expect(mockFetch).not.toHaveBeenCalled()

    mockFetch.mockResolvedValueOnce(response(jsonBody("http://127.0.0.1:9999")))
    await expect(resolveIPPLinkUnsafe(localLink, { fetch: mockFetch })).rejects.toThrow(
      /endpoint mismatch/,
    )
  })
})

// ---------------------------------------------------------------------------
// Carrier equivalence -- short link and ipp1: produce the same object
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- carrier equivalence", () => {
  it("returns exactly what decodeIPPRequest('ipp1:...') returns for the same request", async () => {
    const req = makeRequest(ENDPOINT)
    mockFetch.mockResolvedValueOnce(response(encodeIPPRequest(req, "json")))
    const { request } = await resolveIPPLink(LINK, { fetch: mockFetch })
    const fromCompact = decodeIPPRequest(encodeIPPRequest(req, "compact"))
    expect(request).toEqual(fromCompact)
  })
})

// ---------------------------------------------------------------------------
// Rule 5 -- anonymous request
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- rule 5: anonymous request", () => {
  it("sends only Accept, omits credentials, and requests no referrer", async () => {
    ok()
    await resolveIPPLink(LINK, { fetch: mockFetch })
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(LINK)
    expect(init.method).toBe("GET")
    expect(init.headers).toEqual({ Accept: "application/json" })
    expect(init.credentials).toBe("omit")
    expect(init.referrerPolicy).toBe("no-referrer")
    expect(init.cache).toBe("no-store")
  })
})

// ---------------------------------------------------------------------------
// Rule 7 -- size and time caps
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- rule 7: caps", () => {
  it("aborts a body that exceeds maxBytes while streaming it", async () => {
    mockFetch.mockResolvedValueOnce(streamedResponse(jsonBody(ENDPOINT)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch, maxBytes: 32 })).rejects.toThrow(
      /response too large/,
    )
  })

  it("rejects up front on an oversized Content-Length", async () => {
    mockFetch.mockResolvedValueOnce(
      response(jsonBody(ENDPOINT), { headers: { "content-length": "999999" } }),
    )
    await expect(resolveIPPLink(LINK, { fetch: mockFetch, maxBytes: 1024 })).rejects.toThrow(
      /response too large/,
    )
  })

  it("reads a streamed body that fits", async () => {
    mockFetch.mockResolvedValueOnce(streamedResponse(jsonBody(ENDPOINT)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
  })

  it("surfaces a timeout as ConnectionError and passes an abort signal", async () => {
    mockFetch.mockImplementationOnce((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("The operation was aborted")),
        )
      })
    })
    await expect(resolveIPPLink(LINK, { fetch: mockFetch, timeoutMs: 10 })).rejects.toThrow(
      ConnectionError,
    )
  })
})

// ---------------------------------------------------------------------------
// Rule 8 / 10 -- validation and error envelope mapping
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- W3: the body is judged on bytes", () => {
  const bodyBytes = (prefix: Uint8Array, json = jsonBody(ENDPOINT)): Uint8Array => {
    const tail = new TextEncoder().encode(json)
    const out = new Uint8Array(prefix.length + tail.length)
    out.set(prefix, 0)
    out.set(tail, prefix.length)
    return out
  }
  const BOM = new Uint8Array([0xef, 0xbb, 0xbf])

  it("refuses a body that starts with a UTF-8 BOM", async () => {
    // Fed as BYTES on purpose. Handing the resolver a decoded string would skip
    // the only layer where this is decidable, and pass while doing so.
    mockFetch.mockResolvedValueOnce(response(bodyBytes(BOM)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /must not begin with a UTF-8 BOM/,
    )
  })

  it("shows why the rule cannot live above the bytes", async () => {
    // Both of these decoders DELETE the BOM, so a check written on code points
    // sees a body starting with "{" and accepts it -- while an implementation
    // that keeps the BOM refuses. Same code, one wallet pays, one does not.
    const withBom = bodyBytes(BOM)
    expect(new TextDecoder().decode(withBom).startsWith("{")).toBe(true)
    expect((await new Response(withBom as unknown as BodyInit).text()).startsWith("{")).toBe(true)
    // And the two trim implementations disagree in opposite directions on the
    // exact pair of code points W1 had to pin for URLs.
    expect("\ufeff{}".trim().startsWith("{")).toBe(true)
    expect("\u0085{}".trim().startsWith("{")).toBe(false)
  })

  it("accepts only the four RFC 8259 whitespace bytes as leading whitespace", async () => {
    for (const byte of [0x20, 0x09, 0x0a, 0x0d]) {
      mockFetch.mockResolvedValueOnce(response(bodyBytes(new Uint8Array([byte, byte]))))
      await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
    }
  })

  const notJsonWhitespace: Array<[string, number[]]> = [
    ["U+0085 NEL (Go's TrimSpace strips it)", [0xc2, 0x85]],
    ["U+000B vertical tab", [0x0b]],
    ["U+000C form feed", [0x0c]],
    ["U+00A0 no-break space", [0xc2, 0xa0]],
    ["U+2028 line separator", [0xe2, 0x80, 0xa8]],
    ["U+3000 ideographic space", [0xe3, 0x80, 0x80]],
  ]
  for (const [name, prefix] of notJsonWhitespace) {
    it(`refuses a body led by ${name}`, async () => {
      mockFetch.mockResolvedValueOnce(response(bodyBytes(new Uint8Array(prefix))))
      await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
        /must be a bare JSON IPPMessage/,
      )
    })
  }

  it("refuses a BOM that follows leading whitespace", async () => {
    mockFetch.mockResolvedValueOnce(
      response(bodyBytes(new Uint8Array([0x20, 0xef, 0xbb, 0xbf]))),
    )
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /must be a bare JSON IPPMessage/,
    )
  })

  const illFormed: Array<[string, number[]]> = [
    ["a bare continuation byte", [0x80]],
    ["a lone 0xFF", [0xff]],
    ["a lone 0xFE", [0xfe]],
    ["an overlong two-byte NUL (C0 80)", [0xc0, 0x80]],
    ["an overlong slash (C1 AF)", [0xc1, 0xaf]],
    ["an overlong three-byte form (E0 80 AF)", [0xe0, 0x80, 0xaf]],
    ["a surrogate half (ED A0 80)", [0xed, 0xa0, 0x80]],
    ["a value above U+10FFFF (F4 90 80 80)", [0xf4, 0x90, 0x80, 0x80]],
    ["a five-byte lead (F8 88 80 80 80)", [0xf8, 0x88, 0x80, 0x80, 0x80]],
    ["a truncated sequence (E2 82)", [0xe2, 0x82]],
    ["a lead byte followed by ASCII (C3 41)", [0xc3, 0x41]],
  ]
  for (const [name, injected] of illFormed) {
    it(`refuses a body containing ${name}`, async () => {
      // Injected inside a string VALUE, where the substituted text parses
      // cleanly -- so this is only catchable before the decode.
      const head = new TextEncoder().encode(`${jsonBody(ENDPOINT).slice(0, -1)},"meta":{"x":"`)
      const tail = new TextEncoder().encode('"}}')
      const body = new Uint8Array(head.length + injected.length + tail.length)
      body.set(head, 0)
      body.set(new Uint8Array(injected), head.length)
      body.set(tail, head.length + injected.length)
      mockFetch.mockResolvedValueOnce(response(body))
      await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
        /must be well-formed UTF-8/,
      )
    })
  }

  it("shows why ill-formed UTF-8 has to be refused before the decode", async () => {
    // The decoder is lossy in a way that breaks the key rules underneath it:
    // two DIFFERENT invalid bytes become the SAME character, so keys that differ
    // on the wire arrive identical and duplicate detection both misfires and
    // misses. And the substituted text parses cleanly, so nothing downstream
    // notices that anything happened.
    const ff = new TextDecoder().decode(new Uint8Array([0xff]))
    const fe = new TextDecoder().decode(new Uint8Array([0xfe]))
    expect(ff).toBe(fe)
    expect(ff.codePointAt(0)).toBe(0xfffd)
    const substituted = new TextDecoder().decode(
      new Uint8Array([0x7b, 0x22, 0x76, 0x22, 0x3a, 0x31, 0x2c, 0x22, 0xff, 0x22, 0x3a, 0x32, 0x7d]),
    )
    expect(Object.keys(JSON.parse(substituted) as object)).toHaveLength(2)
  })

  it("accepts well-formed multi-byte UTF-8 in a value", async () => {
    // The rule is well-formedness, not "stay inside ASCII". Two-, three- and
    // four-byte sequences all have to get through, or every non-Latin merchant
    // name stops working.
    const msg = JSON.parse(jsonBody(ENDPOINT)) as Record<string, unknown>
    msg["meta"] = { merchantName: `Caf${cp(0xe9)} ${cp(0x4e2d)} ${cp(0x1f600)}` }
    mockFetch.mockResolvedValueOnce(response(JSON.stringify(msg)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
  })

  it("refuses a duplicate top-level key", async () => {
    // The subset check runs on a parsed object, where the duplicate is already
    // gone -- one parser keeps the last value, another errors. So this is
    // decided on the text, before anything folds it.
    const json = jsonBody(ENDPOINT)
    const dup = `${json.slice(0, -1)},"v":2}`
    mockFetch.mockResolvedValueOnce(response(dup))
    expect(Object.keys(JSON.parse(dup) as object)).toHaveLength(5)
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /duplicate top-level key "v"/,
    )
  })

  it("refuses a top-level key spelled with an escape", async () => {
    // "\u0076" IS "v", and that is the whole problem: parse first and the key
    // is inside the closed set with its duplicate folded away; compare written
    // spellings and it is outside the set. Two implementations, opposite
    // verdicts, both following "the key must be one of five". Refusing the
    // escape deletes the unescaping step, and with it the choice of layer.
    const json = jsonBody(ENDPOINT)
    const escaped = `{"\\u0076":1,${json.slice(1)}`
    expect(Object.keys(JSON.parse(escaped) as object)).toContain("v")
    mockFetch.mockResolvedValueOnce(response(escaped))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /must not contain a backslash escape/,
    )
  })

  it("does not treat a duplicate nested key as a top-level duplicate", async () => {
    // The rule is about the envelope's own keys; nesting is the payload's
    // business. Widening it here would refuse bodies the rule permits.
    const msg = JSON.parse(jsonBody(ENDPOINT)) as Record<string, unknown>
    const payload = JSON.stringify(msg["payload"])
    const dupNested = `${payload.slice(0, -1)},"mode":"multi"}`
    const body = jsonBody(ENDPOINT).replace(payload, dupNested)
    mockFetch.mockResolvedValueOnce(response(body))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
  })
})

describe("resolveIPPLink -- rules 8 and 10", () => {
  it("runs validateIPPRequest on the resolved payload", async () => {
    const bad = JSON.parse(jsonBody(ENDPOINT)) as Record<string, unknown>
    delete (bad["payload"] as Record<string, unknown>)["identity_commitment"]
    mockFetch.mockResolvedValueOnce(response(JSON.stringify(bad)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /identityCommitment is required/,
    )
  })

  it("rejects a compact ipp1: body even though the shared decoder understands it", async () => {
    // The request declared Accept: application/json. A second accepted encoding
    // buys nothing and gives the Go and TS implementations something to disagree on.
    mockFetch.mockResolvedValueOnce(response(encodeIPPRequest(makeRequest(ENDPOINT), "compact")))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /must be a bare JSON IPPMessage/,
    )
  })

  it("rejects an unexpected top-level key in the envelope", async () => {
    const msg = JSON.parse(jsonBody(ENDPOINT)) as Record<string, unknown>
    msg["extra_field"] = "surprise"
    mockFetch.mockResolvedValueOnce(response(JSON.stringify(msg)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      // The wire spelling, not the camelCased one: the rule is decided on the
      // literal key as written, before any transcoding.
      /unexpected top-level key "extra_field"/,
    )
  })

  it("rejects a JSON body that is not an object", async () => {
    mockFetch.mockResolvedValueOnce(response("[]"))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(/Invalid IPP link/)
  })

  it("accepts the envelope with meta omitted", async () => {
    const msg = JSON.parse(jsonBody(ENDPOINT)) as Record<string, unknown>
    delete msg["meta"]
    mockFetch.mockResolvedValueOnce(response(JSON.stringify(msg)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
  })

  it("rejects a voucher envelope served on a link", async () => {
    const msg = JSON.parse(jsonBody(ENDPOINT)) as Record<string, unknown>
    msg["type"] = "voucher"
    mockFetch.mockResolvedValueOnce(response(JSON.stringify(msg)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toThrow(
      /expected type "request"/,
    )
  })

  it("maps 404 link_not_found to NotFoundError", async () => {
    mockFetch.mockResolvedValueOnce(
      response(
        JSON.stringify({
          error: { type: "not_found_error", code: "link_not_found", message: "no such link" },
        }),
        { status: 404 },
      ),
    )
    const err = await resolveIPPLink(LINK, { fetch: mockFetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundError)
    expect((err as NotFoundError).code).toBe("link_not_found")
    expect((err as NotFoundError).statusCode).toBe(404)
  })

  it("maps 400 link_expired to InvalidRequestError", async () => {
    mockFetch.mockResolvedValueOnce(
      response(
        JSON.stringify({
          error: { type: "invalid_request_error", code: "link_expired", message: "expired" },
        }),
        { status: 400 },
      ),
    )
    const err = await resolveIPPLink(LINK, { fetch: mockFetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(InvalidRequestError)
    expect((err as InvalidRequestError).code).toBe("link_expired")
  })

  it("wraps a non-envelope error body as ConnectionError", async () => {
    mockFetch.mockResolvedValueOnce(response("<html>nope</html>", { status: 502 }))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toBeInstanceOf(ConnectionError)
  })

  it("wraps a transport failure as ConnectionError", async () => {
    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).rejects.toBeInstanceOf(ConnectionError)
  })
})

// ---------------------------------------------------------------------------
// W1 -- port canonical form, authority ASCII-only
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- W1: authority spelling", () => {
  const badPorts = ["0443", "08443", "00", "0", ""]
  for (const port of badPorts) {
    it(`rejects a non-canonical port ":${port}"`, async () => {
      // new URL() drops ":0443" as a default port; a parser that compares the
      // port as a string keeps it. Same printed code, two derived endpoints.
      await expect(
        resolveIPPLink(`https://${PUBLIC_HOST}:${port}/ipp/v1/link/${TOKEN}`, {
          fetch: mockFetch,
        }),
      ).rejects.toThrow(/port must be written in canonical form/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  it("accepts a canonical port and the top of the range", async () => {
    for (const [port, derived] of [
      ["443", `https://${PUBLIC_HOST}`],
      ["8443", `https://${PUBLIC_HOST}:8443`],
      ["65535", `https://${PUBLIC_HOST}:65535`],
    ] as Array<[string, string]>) {
      mockFetch.mockResolvedValueOnce(response(jsonBody(derived)))
      const { endpoint } = await resolveIPPLink(
        `https://${PUBLIC_HOST}:${port}/ipp/v1/link/${TOKEN}`,
        { fetch: mockFetch },
      )
      expect(endpoint).toBe(derived)
    }
  })

  for (const port of ["65536", "99999", "4294967296"]) {
    it(`rejects the out-of-range port ":${port}" locally`, async () => {
      await expect(
        resolveIPPLink(`https://${PUBLIC_HOST}:${port}/ipp/v1/link/${TOKEN}`, {
          fetch: mockFetch,
        }),
      ).rejects.toThrow(/port must be <= 65535/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  it("does not lean on the host runtime for the port range", async () => {
    // Node's new URL() happens to throw on these, and that is exactly why the
    // rule cannot be left to it: this package also ships to browsers and React
    // Native, and a runtime that quietly accepted :65536 would make this side
    // accept a code the other side refuses -- with the suite green, because the
    // suite runs on Node. The premise is recorded; the decision is local.
    expect(() => new URL(`https://${PUBLIC_HOST}:65536/x`)).toThrow()
    expect(new URL(`https://${PUBLIC_HOST}:65535/x`).port).toBe("65535")
  })

  // The load-bearing one. UTS-46 does not reject these code points, it DELETES
  // them: without the ASCII rule, `pay<ZWSP>.example.com` is fetched as
  // `pay.example.com` -- a request to a host that is not in the URL -- and the
  // path still matches, so no later check notices.
  const nonAsciiHosts: Array<[string, string]> = [
    ["U+200B ZWSP (deleted by UTS-46)", "pay" + cp(0x200b) + ".example.com"],
    ["U+00AD soft hyphen (deleted by UTS-46)", "pay" + cp(0x00ad) + ".example.com"],
    ["U+00E4 (mapped to punycode)", "p" + cp(0x00e4) + "y.example.com"],
    ["U+3002 ideographic full stop (mapped to '.')", "pay" + cp(0x3002) + "example.com"],
  ]
  for (const [name, host] of nonAsciiHosts) {
    it(`rejects a non-ASCII authority: ${name}`, async () => {
      await expect(
        resolveIPPLink(`https://${host}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).rejects.toThrow(/authority must be ASCII only/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  it("proves the ZWSP host would otherwise be fetched as a different host", async () => {
    // Without this rule the request goes to pay.example.com. Asserting what
    // WHATWG does here keeps the reason for the rule visible if it is ever
    // questioned, and would catch a runtime that stopped doing the mapping.
    const zwsp = cp(0x70, 0x61, 0x79, 0x200b) + ".example.com"
    expect(new URL(`https://${zwsp}/x`).hostname).toBe("pay.example.com")
    expect(zwsp).not.toBe("pay.example.com")
  })

  it("accepts a punycode IDN host, which is the interoperable spelling", async () => {
    // Unsafe variant so a name needs no resolver; the URL parsing is shared.
    const puny = "xn--py-via.example.com"
    mockFetch.mockResolvedValueOnce(response(jsonBody(`https://${puny}`)))
    const { endpoint } = await resolveIPPLinkUnsafe(`https://${puny}/ipp/v1/link/${TOKEN}`, {
      fetch: mockFetch,
    })
    expect(endpoint).toBe(`https://${puny}`)
  })
})

// ---------------------------------------------------------------------------
// W1 -- host and path must be written in one canonical spelling
// ---------------------------------------------------------------------------

describe("resolveIPPLink -- W1: the host has exactly one legal spelling", () => {
  // Each of these is a spelling a WHATWG parser silently REWRITES into some
  // other host, while a parser that only lowercases keeps it as written. Two
  // implementations then derive two different endpoints from one printed code:
  // the cross-check passes in one wallet and fails in the other. The written
  // form is therefore judged before any parser sees it.
  const nonCanonical: Array<[string, string, string, RegExp]> = [
    ["uncompressed IPv6", "[2001:db8:0:0:0:0:0:1]", "[2001:db8::1]", /RFC 5952 canonical form/],
    ["IPv6 with a padded group", "[0::1]", "[::1]", /RFC 5952 canonical form/],
    ["IPv6 with a leading zero in a group", "[::01]", "[::1]", /RFC 5952 canonical form/],
    // RFC 5952 section 5 gives the mixed notation to v4-mapped and to nothing
    // else, so the dotted tail is canonical in the first row here and refused
    // in the next two -- and the pure-hex v4-mapped spelling, which is what a
    // WHATWG serializer prints, is the one that is now wrong.
    [
      "v4-mapped written in pure hex",
      "[::ffff:7f00:1]",
      "[::ffff:7f00:1]",
      /RFC 5952 canonical form/,
    ],
    [
      "v4-compatible in mixed notation",
      "[::127.0.0.1]",
      "[::7f00:1]",
      /RFC 5952 canonical form/,
    ],
    [
      "NAT64 in mixed notation",
      "[64:ff9b::10.0.0.1]",
      "[64:ff9b::a00:1]",
      /RFC 5952 canonical form/,
    ],
    [
      "v4-mapped with a padded octet",
      "[::ffff:01.2.3.4]",
      "[::ffff:01.2.3.4]",
      /RFC 5952 canonical form/,
    ],
    ["uppercase IPv6", "[2001:DB8::1]", "[2001:db8::1]", /lowercase hexadecimal/],
    ["IPv4 with a leading zero", "01.2.3.4", "1.2.3.4", /four decimal octets/],
    ["IPv4 with a padded last octet", "1.2.3.04", "1.2.3.4", /four decimal octets/],
    ["IPv4 in octal", "0177.0.0.1", "127.0.0.1", /four decimal octets/],
    ["IPv4 with three segments", "203.0.113", "203.0.0.113", /four decimal octets/],
    [
      "IPv4 in hex",
      "0x7f000001",
      "127.0.0.1",
      /must not end in a label that reads as a number/,
    ],
    ["IPv4 as one integer", "3405803625", "203.0.112.105", /four decimal octets/],
    ["percent escape in the host", "h%2e", "h.", /only letters, digits and hyphens/],
    ["empty label", "h..example", "h..example", /empty label or a trailing dot/],
    ["underscore in a label", "h_x.example", "h_x.example", /only letters, digits and hyphens/],
    // A trailing dot is a second spelling of one host, and the cross-check is
    // string equality -- two spellings means one server with two unequal names.
    // WHATWG keeps the dot, so this is stricter than the parser on purpose.
    ["trailing dot", "pay.example.com.", "pay.example.com.", /empty label or a trailing dot/],
    ["bare trailing dot", "h.", "h.", /empty label or a trailing dot/],
    ["leading hyphen label", "-h.example", "-h.example", /must not start or end with a hyphen/],
    ["trailing hyphen label", "h-.example", "h-.example", /must not start or end with a hyphen/],
    [
      "64-character label",
      `${"a".repeat(64)}.example`,
      `${"a".repeat(64)}.example`,
      /at most 63 characters/,
    ],
  ]

  for (const [name, host, , reason] of nonCanonical) {
    it(`rejects ${name} ("${host}")`, async () => {
      await expect(
        resolveIPPLink(`https://${host}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).rejects.toThrow(reason)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  it("records what a parser would have turned each spelling into", () => {
    // The reason the rule exists, kept next to the rule. If a runtime ever
    // stopped rewriting these, this is where that shows up -- and the entries
    // whose host is unchanged are the ones refused for being unparseable as a
    // name at all, not for being rewritten.
    for (const [, host, rewritten] of nonCanonical) {
      let actual: string
      try {
        actual = new URL(`https://${host}/x`).host
      } catch {
        actual = host
      }
      expect({ host, actual }).toEqual({ host, actual: rewritten })
    }
  })

  const canonical: Array<[string, string]> = [
    ["dotted-quad IPv4", "203.0.113.10"],
    ["compressed IPv6", "[2001:db8::1]"],
    ["IPv6 with a single uncompressed zero group", "[2001:db8:0:1:1:1:1:1]"],
    ["LDH name", "api-test.invisipay.fi"],
    ["punycode IDN", "xn--py-via.example.com"],
    ["mixed-case name (compared lowercased)", "API-Test.Invisipay.FI"],
    ["63-character label", `${"a".repeat(63)}.example`],
    ["hyphen inside a label", "a-b-c.example"],
  ]

  for (const [name, host] of canonical) {
    it(`accepts ${name} ("${host}")`, async () => {
      const derived = `https://${host.toLowerCase()}`
      mockFetch.mockResolvedValueOnce(response(jsonBody(derived)))
      // Unsafe entry so a name needs no resolver; the spelling rules are shared.
      const { endpoint } = await resolveIPPLinkUnsafe(
        `https://${host}/ipp/v1/link/${TOKEN}`,
        { fetch: mockFetch },
      )
      expect(endpoint).toBe(derived)
    })
  }

  it("compresses the leftmost of two equal-length zero runs", async () => {
    // RFC 5952 4.2.3. Both spellings below are the same address; only one is
    // canonical, and picking the other tie-break makes one wallet derive
    // "1::1:0:0:1:1" where the other derives "1:0:0:1::1:1".
    mockFetch.mockResolvedValueOnce(response(jsonBody("https://[1::1:0:0:1:1]")))
    const { endpoint } = await resolveIPPLink(`https://[1::1:0:0:1:1]/ipp/v1/link/${TOKEN}`, {
      fetch: mockFetch,
    })
    expect(endpoint).toBe("https://[1::1:0:0:1:1]")

    await expect(
      resolveIPPLink(`https://[1:0:0:1::1:1]/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/RFC 5952 canonical form/)
  })

  it("keeps a single zero group uncompressed rather than over-compressing", async () => {
    // RFC 5952 4.2.2: "::" must not stand in for one group. Getting this wrong
    // in either direction makes one legal address unwritable.
    await expect(
      resolveIPPLink(`https://[2001:db8::1:1:1:1:1]/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/RFC 5952 canonical form/)
  })
})

describe("resolveIPPLink -- W1: 'ends in a number' matches the URL Standard", () => {
  // The rule is pinned to the WHATWG "ends in a number" algorithm rather than
  // to a description of it, because two implementations describing the same
  // algorithm independently is how the earlier divergences started. So the
  // oracle here is a real WHATWG parser, not a second description: for each
  // final label, does `new URL` treat the host as an IPv4 attempt?
  const labels = [
    "com", "example", "fi", "xn--py-via", "a", "z9", "9a", "a9",
    "0x", "0X", "0x0", "0x7f000001", "0X7F000001", "0xg", "0xzz",
    "1", "0", "00", "01", "08", "09", "0177", "017", "0o17", "123456",
    "3405803625", "4294967296", "1e3", "0b11", "x0177", "0177x",
    "07777777777", "0999", "10", "255", "256",
  ]

  /** Does a real WHATWG parser read `a.<label>` as an IPv4 attempt? */
  function whatwgReadsAsNumber(label: string): boolean {
    try {
      return new URL(`https://a.${label}/x`).hostname !== `a.${label.toLowerCase()}`
    } catch {
      return true
    }
  }

  for (const label of labels) {
    const expected = whatwgReadsAsNumber(label)
    it(`${expected ? "refuses" : "accepts"} the final label "${label}"`, async () => {
      const host = `a.${label}`
      const link = `https://${host}/ipp/v1/link/${TOKEN}`
      if (expected) {
        await expect(resolveIPPLinkUnsafe(link, { fetch: mockFetch })).rejects.toThrow(
          /must not end in a label that reads as a number/,
        )
        expect(mockFetch).not.toHaveBeenCalled()
        return
      }
      // Unsafe entry: these are names, and the point here is the spelling rule,
      // not name resolution.
      const derived = `https://${host.toLowerCase()}`
      mockFetch.mockResolvedValueOnce(response(jsonBody(derived)))
      const { endpoint } = await resolveIPPLinkUnsafe(link, { fetch: mockFetch })
      expect(endpoint).toBe(derived)
    })
  }

  it("agrees with the octal branch of the algorithm specifically", async () => {
    // The octal branch is the one a paraphrase drops, so it is worth stating
    // where it can and cannot matter: it only fires on a label starting with
    // "0" that is not all digits, and octal digits are a subset of decimal
    // digits -- so every label it accepts was already accepted for being all
    // digits. `0177.0.0.1` is refused by the IPv4 branch (four octets, leading
    // zero), and its FINAL label is plain "1".
    await expect(
      resolveIPPLink(`https://0177.0.0.1/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/IPv4 host must be four decimal octets/)
    // A label that only an octal reading could reach, and that reading fails.
    for (const label of ["0o17", "0b11", "0a"]) {
      const derived = `https://a.${label}`
      mockFetch.mockResolvedValueOnce(response(jsonBody(derived)))
      await expect(
        resolveIPPLinkUnsafe(`https://a.${label}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).resolves.toBeDefined()
    }
  })
})

describe("resolveIPPLink -- the endpoint is the written string", () => {
  // The derived endpoint is what the caller feeds to IPPClient, what lands in
  // logs and telemetry, and what a confirmation screen shows. It is built from
  // the URL as written, with exactly two normalizations applied -- the two the
  // spelling rules leave open. A URL parser's rendering is not used, because
  // each runtime renders differently and a third implementation would produce a
  // third spelling of the same endpoint.
  const cases: Array<[string, string, string]> = [
    // The case that forced the rule: a parser prints this host as
    // [::ffff:102:304], which no other implementation would ever return.
    ["v4-mapped IPv6", "[::ffff:1.2.3.4]", "https://[::ffff:1.2.3.4]"],
    ["compressed IPv6", "[2001:db8::1]", "https://[2001:db8::1]"],
    ["IPv6 with a port", "[2001:db8::1]:8443", "https://[2001:db8::1]:8443"],
    ["dotted-quad IPv4", "203.0.113.10", "https://203.0.113.10"],
    // Normalization 1: a reg-name's letter case.
    ["mixed-case name", "API-Test.Invisipay.FI", "https://api-test.invisipay.fi"],
    // Normalization 2: a port equal to the scheme's default.
    ["explicit default port", "api-test.invisipay.fi:443", "https://api-test.invisipay.fi"],
    ["non-default port", "api-test.invisipay.fi:8443", "https://api-test.invisipay.fi:8443"],
  ]

  for (const [name, host, expected] of cases) {
    it(`derives ${expected} from ${name} written as "${host}"`, async () => {
      mockFetch.mockResolvedValueOnce(response(jsonBody(expected)))
      // Unsafe entry for the names, so none of this touches a resolver; the
      // derivation is shared with resolveIPPLink.
      const { endpoint } = await resolveIPPLinkUnsafe(
        `https://${host}/ipp/v1/link/${TOKEN}`,
        { fetch: mockFetch },
      )
      expect(endpoint).toBe(expected)
    })
  }

  it("proves a parser would have returned something else for the v4-mapped host", () => {
    // Kept next to the rule: this is the divergence the rule closes, and if a
    // runtime ever stopped rewriting it, this is where that surfaces.
    expect(new URL("https://[::ffff:1.2.3.4]/x").host).toBe("[::ffff:102:304]")
  })

  it("requests the URL as scanned, not a re-rendering of it", async () => {
    const written = `https://API-Test.Invisipay.FI/ipp/v1/link/${TOKEN}`
    mockFetch.mockResolvedValueOnce(response(jsonBody("https://api-test.invisipay.fi")))
    await resolveIPPLinkUnsafe(written, { fetch: mockFetch })
    expect(mockFetch.mock.calls[0]?.[0]).toBe(written)
  })
})

describe("resolveIPPLink -- W1: the path is judged by character set", () => {
  // Not by "equals what this parser normalizes it to" -- that has no judge
  // outside the local runtime, so two runtimes disagree by construction. These
  // are the characters that actually differ: rewritten to %7C / %5E in one
  // place, a parse error in another.
  const outsidePchar: Array<[string, string]> = [
    ["pipe", "|"],
    ["caret", "^"],
    ["backslash", cp(0x5c)],
    ["double quote", '"'],
    ["angle bracket", "<"],
    ["brace", "{"],
    ["backtick", "`"],
    ["square bracket", "["],
    ["non-ASCII", cp(0xe9)],
  ]
  for (const [name, ch] of outsidePchar) {
    it(`rejects ${name} in a path segment`, async () => {
      await expect(
        resolveIPPLink(`${ENDPOINT}/a${ch}b/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).rejects.toThrow(/must contain only RFC 3986 pchar/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  const malformedEscapes = ["%", "%b", "%1", "%zz", "%g0", "%1g"]
  for (const esc of malformedEscapes) {
    it(`rejects the malformed percent escape "${esc}"`, async () => {
      await expect(
        resolveIPPLink(`${ENDPOINT}/a${esc}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).rejects.toThrow(/must contain only RFC 3986 pchar/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  const lowercaseEscapes = ["%2f", "%4a", "%ab", "%aB", "%Ab", "%ff"]
  for (const escape of lowercaseEscapes) {
    it(`refuses the lowercase percent escape "${escape}"`, async () => {
      await expect(
        resolveIPPLink(`${ENDPOINT}/a${escape}b/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      ).rejects.toThrow(/must use uppercase hex digits/)
      expect(mockFetch).not.toHaveBeenCalled()
    })
  }

  it("accepts the same escapes written in uppercase", async () => {
    for (const escape of ["%2F", "%4A", "%AB", "%FF"]) {
      const prefix = `/a${escape}b`
      mockFetch.mockResolvedValueOnce(response(jsonBody(`${ENDPOINT}${prefix}`)))
      const { endpoint } = await resolveIPPLink(
        `${ENDPOINT}${prefix}/ipp/v1/link/${TOKEN}`,
        { fetch: mockFetch },
      )
      expect(endpoint).toBe(`${ENDPOINT}${prefix}`)
    }
  })

  it("refuses the case difference instead of normalizing it away", async () => {
    // The divergence this closes: rule 9 is a string comparison, while RFC 3986
    // section 6.2.2.1 says to uppercase escapes before comparing. Same printed
    // code, refused by one reading and paid by the other. Both spellings match
    // the pchar shape, so only an explicit case rule sees the difference -- and
    // it has to fire on the payload side too, or the endpoint written one way
    // and derived the other would still disagree.
    mockFetch.mockResolvedValueOnce(response(jsonBody(`${ENDPOINT}/a%41%2fb`)))
    await expect(
      resolveIPPLink(`${ENDPOINT}/a%41%2Fb/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
    ).rejects.toThrow(/payload\.endpoint: percent-encoded byte "%2f" must use uppercase/)
  })

  it("accepts every other pchar character in a path prefix", async () => {
    // sub-delims, ':' and '@' are legal in a path and no parser rewrites them.
    // Refusing them would be a new divergence in the other direction.
    const prefix = "/a-b.c_d~e!f$g&h'i(j)k*l+m,n;o=p:q@r/%2Fs%41"
    mockFetch.mockResolvedValueOnce(response(jsonBody(`${ENDPOINT}${prefix}`)))
    const { endpoint } = await resolveIPPLink(`${ENDPOINT}${prefix}/ipp/v1/link/${TOKEN}`, {
      fetch: mockFetch,
    })
    expect(endpoint).toBe(`${ENDPOINT}${prefix}`)
  })

  it("carries the path through as written, not as the parser rendered it", async () => {
    // %41 is 'A'. A parser that decoded it would derive a different endpoint;
    // taking the written path keeps the derived value independent of that.
    const prefix = "/%41"
    mockFetch.mockResolvedValueOnce(response(jsonBody(`${ENDPOINT}${prefix}`)))
    const { endpoint } = await resolveIPPLink(`${ENDPOINT}${prefix}/ipp/v1/link/${TOKEN}`, {
      fetch: mockFetch,
    })
    expect(endpoint).toBe(`${ENDPOINT}/%41`)
    expect(endpoint).not.toBe(`${ENDPOINT}/A`)
  })
})

// ---------------------------------------------------------------------------
// W2 -- payload.endpoint runs the SAME wire rules as the link URL
// ---------------------------------------------------------------------------

describe("payload.endpoint and the link URL share one set of wire rules", () => {
  // One table, two loops, and each row carries the REASON it must be refused
  // for -- not merely "refused". Asserting only that it was refused is the W6
  // trap: nearly every row below is also caught by the normal-form check, so a
  // rule moved out of the shared parser into one wrapper leaves both loops
  // green while the two sides quietly disagree. This table is the only
  // mechanical guard against that, so the reason has to be pinned.
  const malformed: Array<[string, string, RegExp]> = [
    ["userinfo", `https://good.com@${PUBLIC_HOST}`, /must not contain userinfo/],
    [
      "backslash authority",
      `https://${PUBLIC_HOST}${cp(0x5c)}evil.example`,
      /authority must not contain a backslash/,
    ],
    [
      "non-ASCII authority",
      `https://pay${cp(0x200b)}.example.com`,
      /authority must be ASCII only/,
    ],
    [
      "leading-zero port",
      `https://${PUBLIC_HOST}:0443`,
      /port must be written in canonical form/,
    ],
    ["empty port", `https://${PUBLIC_HOST}:`, /port must be written in canonical form/],
    ["dot segment", `https://${PUBLIC_HOST}/api/../api`, /must not contain "\." or "\.\." segments/],
    [
      "percent-encoded dot segment",
      `https://${PUBLIC_HOST}/api/%2e%2e/api`,
      /must not contain "\." or "\.\." segments/,
    ],
    ["control character", `https://${PUBLIC_HOST}${cp(0x01)}`, /whitespace or control characters/],
    [
      "C1 control character",
      `https://${PUBLIC_HOST}${cp(0x85)}`,
      /whitespace or control characters/,
    ],
    // The two sides word this one differently (path prefix vs whole path), so
    // the pattern names the rule rather than either message.
    ["empty path segment", `https://${PUBLIC_HOST}//api`, /malformed (endpoint path prefix|path)/],
    ["not https", `http://${PUBLIC_HOST}`, /scheme must be the lowercase literal "https"/],
    ["uppercase scheme", `HTTPS://${PUBLIC_HOST}`, /scheme must be the lowercase literal/],
    // Outside pchar: WHATWG percent-encodes it, a parser reading the escaped
    // path keeps it as written -- two derived endpoints from one printed code.
    [
      "non-ASCII in the path",
      `https://${PUBLIC_HOST}/caf${cp(0xe9)}`,
      /must contain only RFC 3986 pchar/,
    ],
    ["pipe in the path", `https://${PUBLIC_HOST}/a|b`, /must contain only RFC 3986 pchar/],
    [
      "lowercase percent escape",
      `https://${PUBLIC_HOST}/a%2fb`,
      /percent-encoded byte "%2f" must use uppercase hex digits/,
    ],
    ["caret in the path", `https://${PUBLIC_HOST}/a^b`, /must contain only RFC 3986 pchar/],
    [
      "malformed percent escape in the path",
      `https://${PUBLIC_HOST}/a%b`,
      /must contain only RFC 3986 pchar/,
    ],
    [
      "backslash in the path",
      `https://${PUBLIC_HOST}/a${cp(0x5c)}b`,
      /must contain only RFC 3986 pchar/,
    ],
    [
      "non-canonical IPv6 authority",
      "https://[2001:db8:0:0:0:0:0:1]",
      /IPv6 host must be in RFC 5952 canonical form/,
    ],
    [
      "IPv4 authority with a leading zero",
      "https://01.2.3.4",
      /IPv4 host must be four decimal octets/,
    ],
    [
      "numeric final label",
      "https://0x7f000001",
      /must not end in a label that reads as a number/,
    ],
    ["trailing dot", "https://pay.example.com.", /empty label or a trailing dot/],
    ["leading hyphen label", "https://-h.example", /must not start or end with a hyphen/],
    ["over-long label", `https://${"a".repeat(64)}.example`, /at most 63 characters/],
    [
      "v4-mapped written in pure hex",
      "https://[::ffff:7f00:1]",
      /RFC 5952 canonical form/,
    ],
    ["out-of-range port", `https://${PUBLIC_HOST}:65536`, /port must be <= 65535/],
  ]

  async function messageOf(p: Promise<unknown>): Promise<string> {
    const err = await p.then(
      () => new Error("EXPECTED A REJECTION"),
      (e: unknown) => e,
    )
    return err instanceof Error ? err.message : String(err)
  }

  for (const [name, bad, reason] of malformed) {
    it(`link URL side refuses ${name}`, async () => {
      const msg = await messageOf(
        resolveIPPLink(`${bad}/ipp/v1/link/${TOKEN}`, { fetch: mockFetch }),
      )
      expect(msg).toMatch(/^Invalid IPP link:/)
      expect(msg).toMatch(reason)
      expect(mockFetch).not.toHaveBeenCalled()
    })

    it(`payload.endpoint side refuses ${name}`, async () => {
      mockFetch.mockResolvedValueOnce(response(jsonBody(bad)))
      const msg = await messageOf(resolveIPPLink(LINK, { fetch: mockFetch }))
      // The prefix separates "this endpoint is malformed" from a plain mismatch;
      // the reason separates the intended rule from whatever else caught it.
      expect(msg).toMatch(/^Invalid IPP link response payload\.endpoint:/)
      expect(msg).toMatch(reason)
    })
  }

  it("keeps the /ipp/v1/link/<token> suffix rule on the link side only", async () => {
    // The one asymmetry: payload.endpoint is a server root, not a scanned link.
    mockFetch.mockResolvedValueOnce(response(jsonBody(ENDPOINT)))
    await expect(resolveIPPLink(LINK, { fetch: mockFetch })).resolves.toBeDefined()
    await expect(resolveIPPLink(ENDPOINT, { fetch: mockFetch })).rejects.toThrow(
      /path must end with "\/ipp\/v1\/link\//,
    )
  })
})

// ---------------------------------------------------------------------------
// Every verdict comes from a named rule
// ---------------------------------------------------------------------------

describe("the accepted set is defined entirely by explicit rules", () => {
  // No URL library is in the decision path -- a parser could only ever add
  // strictness on THIS side, and one-sided strictness is the shape of every
  // divergence this rule set closes. What replaces it is this sweep: for a
  // corpus of malformed URLs, every rejection must come from a rule named
  // below, and the set of inputs that get through must be exactly the list at
  // the bottom.
  //
  // Both halves catch a deleted rule, by different routes: its pattern stops
  // matching anything, and/or inputs it used to refuse become accepted.
  const authorities = [
    "h.example", "[::1", "::1]", "[::1]]", "[[::1]]", "[]", "[::1]:", "[::1]:0",
    "[::1]:65536", "[fffff::1]", "[1:2:3:4:5:6:7:8:9]", "[1::2::3]", "[:::1]",
    "[::ffff:1.2.3.4.5]", "[::ffff:256.1.1.1]", "1.2.3.4.5", "1.2.3.256", "1.2.3.4:",
    "h.example:", "h.example:0", "h.example:65536", "h.example:99999999999",
    `${"a".repeat(300)}.example`, "h.example:12:34", "h:example", "%", "%%",
    "h.example.", ".h.example", "-", "--", "h-.example", "[", "]", ":", "::",
    "h.example:1:2", "0.0.0.0", "255.255.255.255", "[::]", "[0:0:0:0:0:0:0:0]",
    // Added so that RULES below is a genuine enumeration rather than "the ones
    // this corpus happens to reach": without these, six rules in parseWireURL
    // were unreachable here, and a seventh rule added later would have been
    // unreachable too -- with assertions 1 and 2 both silent about it.
    "", "user@h.example", `h.example${cp(0x5c)}evil`, `pay${cp(0x200b)}.example`,
  ]
  const paths = [
    "", "/", "//", "/a", "/a/", "/%", "/%2", "/a%2", "/|", "/.", "/..", "/%2e",
    `/a${cp(0x20)}b`,
    // Reaches the URL-shape rule: a query or fragment fails the wire regex
    // before any of the per-part rules get a look.
    "/a?b", "/a#b",
    // Reaches the pct-encoded case rule. Well-formed pchar, so nothing above it
    // can see the difference.
    "/a%2fb",
  ]
  /** Reaches the scheme rule, which no authority or path can. */
  const oddSchemes = [
    `ftp://h.example/ipp/v1/link/${TOKEN}`,
    `HTTPS://h.example/ipp/v1/link/${TOKEN}`,
    `javascript://h.example/ipp/v1/link/${TOKEN}`,
  ]

  /**
   * Every rule reachable from the link-URL side, by name -- which is every rule
   * in parseWireURL plus the two in the link-side wrapper. The corpus above is
   * built to reach all of them, so this really is an enumeration.
   *
   * The one rule not here is normalizeEndpoint's own `malformed path`, which
   * only the payload side can reach; the W2 shared table covers that one, with
   * its reason pinned the same way.
   */
  const RULES: Array<[string, RegExp]> = [
    ["URL shape", /URL must be "<scheme>:\/\/<host><path>" with no query or fragment/],
    ["scheme literal", /scheme must be the lowercase literal/],
    ["no userinfo", /must not contain userinfo/],
    ["host present", /URL has no host/],
    ["backslash authority", /URL authority must not contain a backslash/],
    ["authority ASCII only", /URL authority must be ASCII only/],
    ["control characters", /URL contains whitespace or control characters/],
    ["path is pchar", /URL path segment .* must contain only RFC 3986 pchar/],
    ["pct-encoded uppercase", /percent-encoded byte .* must use uppercase hex digits/],
    ["no dot segments", /URL path must not contain "\." or "\.\." segments/],
    ["no empty path segment", /malformed endpoint path prefix/],
    ["link suffix shape", /path must end with/],
    ["IPv6 brackets paired", /IPv6 host must be enclosed in brackets/],
    ["IPv6 lowercase hex", /IPv6 host must be lowercase hexadecimal/],
    ["IPv6 RFC 5952", /IPv6 host must be in RFC 5952 canonical form/],
    ["IPv4 dotted quad", /IPv4 host must be four decimal octets/],
    ["label charset", /host label .* must contain only letters, digits and hyphens/],
    ["label hyphen position", /host label .* must not start or end with a hyphen/],
    ["label length", /host label must be at most 63 characters/],
    ["no empty label", /host must not contain an empty label or a trailing dot/],
    ["canonical port", /port must be written in canonical form/],
    ["port range", /port must be <= 65535/],
  ]

  const SENTINEL = "REACHED THE NETWORK"

  it("refuses every malformed URL for a named reason, and accepts exactly 16", async () => {
    const reachedNetwork = vi.fn(async () => {
      throw new Error(SENTINEL)
    })
    const unmatched: Array<{ url: string; message: string }> = []
    const accepted: string[] = []
    const fired = new Set<string>()

    const sweep: string[] = [...oddSchemes]
    for (const authority of authorities) {
      for (const path of paths) {
        sweep.push(
          `https://${authority}${path}/ipp/v1/link/${TOKEN}`,
          `https://${authority}${path}`,
          `http://${authority}${path}/ipp/v1/link/${TOKEN}`,
        )
      }
    }
    for (const url of sweep) {
      const message = await resolveIPPLinkUnsafe(url, { fetch: reachedNetwork as never }).then(
        () => SENTINEL,
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      )
      if (message === SENTINEL) {
        accepted.push(url)
        continue
      }
      const rule = RULES.find(([, re]) => re.test(message))
      if (rule === undefined) unmatched.push({ url, message })
      else fired.add(rule[0])
    }

    // No verdict escaped the rules -- nothing was refused for a reason that is
    // not on the list above (which is what a URL library sneaking back in, or
    // an unnamed ad-hoc check, would look like).
    expect(unmatched).toEqual([])

    // Every listed rule still refuses something. A rule that stops firing has
    // been deleted or short-circuited, even if some other rule happens to
    // catch the same inputs.
    expect(RULES.map(([name]) => name).filter((n) => !fired.has(n))).toEqual([])

    // And the exact set that gets through. A rule deleted without another
    // catching its inputs shows up here as a new entry.
    expect(accepted.sort()).toEqual(
      [
        "http://0.0.0.0/a/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "http://0.0.0.0/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "http://255.255.255.255/a/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "http://255.255.255.255/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "http://[::]/a/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "http://[::]/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "http://h.example/a/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "http://h.example/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "https://0.0.0.0/a/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "https://0.0.0.0/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "https://255.255.255.255/a/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "https://255.255.255.255/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "https://[::]/a/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "https://[::]/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "https://h.example/a/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
        "https://h.example/ipp/v1/link/AbCdEfGhIjKlMnOpQrStUv",
      ].sort(),
    )
    // These four hosts are non-public; they get through here only because the
    // sweep uses the Unsafe entry, which is the one that skips rule 4. What is
    // under test is the spelling layer.
    expect(accepted).toHaveLength(16)
  })
})

// ---------------------------------------------------------------------------
// W7 -- this file must stay pure ASCII
// ---------------------------------------------------------------------------

describe("the whitespace set does not delegate to the engine", () => {
  it("keeps \\s out of the control-character class", async () => {
    // A test running on one engine cannot catch this: on this engine every
    // member of \\s is already an enumerated member, so putting it back changes
    // no verdict here -- while on an engine shipping a different Unicode
    // version its Zs tail differs and the accepted set moves with it. The only
    // way to guard "membership is not the runtime's to decide" is to assert it
    // about the source.
    const { readFileSync } = await import("node:fs")
    const here = new URL(".", import.meta.url).pathname
    const src = readFileSync(`${here}link.ts`, "utf8")
    const literal = /const CONTROL_OR_SPACE_RE =\s*(\/\[[^\n]*\]\/)/.exec(src)?.[1]
    expect(literal).toBeDefined()
    expect(literal).not.toContain("\\s")
    // Same for the other classes whose members decide a verdict. Line-scanned
    // rather than pattern-matched: a clever regex here is one more thing that
    // can quietly match nothing and pass.
    const lines = src.split("\n")
    for (const name of ["PCHAR_SEGMENT_RE", "LDH_LABEL_RE", "NON_ASCII_RE", "DOT_SEGMENT_RE"]) {
      const line = lines.find((l) => l.startsWith(`const ${name} = `))
      expect({ name, found: line !== undefined }).toEqual({ name, found: true })
      expect({ name, delegates: line?.includes("\\s") === true }).toEqual({
        name,
        delegates: false,
      })
    }
  })
})

describe("W7: the link module carries no literal invisible characters", () => {
  it("keeps link.ts and both link test files pure ASCII", async () => {
    // Every invisible character above is built with cp(). If one is ever typed
    // in literally, this fails -- which is the point: an editor that normalizes
    // Unicode would otherwise delete it from a MUST-REJECT case and leave the
    // suite green with the rule unguarded.
    const { readFileSync } = await import("node:fs")
    const here = new URL(".", import.meta.url).pathname
    // link.ts is in the list too: it carries \u escapes for the control-character
    // ranges, and a literal character smuggled in beside them would be just as
    // deletable by a formatter as one in a test fixture.
    for (const name of ["link.test.ts", "link.dns.test.ts", "link.ts"]) {
      const src = readFileSync(`${here}${name}`, "utf8")
      const offenders = [...src].filter((ch) => ch.codePointAt(0)! > 0x7f)
      expect({ name, offenders: offenders.map((c) => c.codePointAt(0)!.toString(16)) }).toEqual({
        name,
        offenders: [],
      })
    }
  })
})
