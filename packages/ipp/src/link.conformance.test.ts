import { describe, it, expect, beforeEach } from "vitest"
import { readFileSync } from "node:fs"
import { encodeIPPRequest, decodeIPPRequest } from "./codec"
import * as link from "./link"
import * as errorsMod from "./errors"
import type { HostResolver } from "./link"
import type { IPPRequest } from "./types"

// Conformance run against the shared 06-ipp/6.6 fixture.
//
// This file exists for one failure shape that nothing else in either SDK can
// see. Six times now, this implementation and invisi-sdk-go's ipp/link.go have
// both answered a URL without erroring and answered it DIFFERENTLY. Each side's
// own suite passes in that situation no matter how dense it is, because "the
// other side says otherwise" is not a fact either suite has access to. Reading
// the other side's source found one of the six and cost 661 lines of review;
// the other five were only visible as two verdicts on one input.
//
// So: both sides read THE SAME BYTES and record accept/reject. The fixture is
// the medium for comparing answers, never for copying a decision -- an
// implementation written from the fixture's regexes instead of from the 6.6
// prose destroys the only property that made the six findings possible, which
// is that two readers hit the same ambiguity independently.
//
// ../testdata/link-transport-v1.json is a byte-identical copy of
// protocol-docs/06-ipp/conformance/link-transport-v1.json and is NEVER edited
// here. protocol-docs/06-ipp/conformance/vendored-copies.mjs fails when the two
// differ; --write is the only sanctioned way to change this copy.
//
// Verdicts only, on purpose. Pinning the REASON needs a language-neutral name
// per rule, which does not exist yet; every one of the six divergences shows up
// in the verdict alone.

const HERE = new URL(".", import.meta.url).pathname
const FIXTURE_PATH = `${HERE}../testdata/link-transport-v1.json`

/**
 * What a name with no `resolves_to` in the fixture answers. The fixture lists it
 * under host_policy.public_addresses, so it is public by the same document that
 * supplies the cases.
 */
const PUBLIC_STUB_ADDRESS = "93.184.216.34"

// --- fixture shape ---------------------------------------------------------

interface AcceptCase {
  id: string
  url: string
  token: string
  endpoint: string
  note?: string
}

interface RejectCase {
  id: string
  url?: string
  url_template?: string
  codepoint?: number
  rule: number
  rejected_by: string
  reason: string
  malicious?: boolean
  isolates?: boolean
  requires?: string
  resolves_to?: string[]
  local_name?: boolean
}

/**
 * The stub response a resolve case declares. The body arrives in one of five
 * carriers; body_text_template is the one that exists so an invisible character
 * can be given as a code point instead of a literal, the same reason
 * url_template exists.
 */
interface ResponseSpec {
  status: number
  headers?: Record<string, string>
  body_json_ref?: string
  body_json?: unknown
  body_text?: string
  body_text_template?: string
  body_bytes_hex?: string
  codepoint?: number
}

interface ResolveCase {
  id: string
  url: string
  response: ResponseSpec
  expect: Record<string, unknown>
  malicious?: boolean
}

interface Fixture {
  fixture_version: number
  ipp_version: number
  spec: string
  host_policy: { public_addresses: Array<{ address: string; why: string }> }
  envelope: {
    error_envelope_shape_pairs: Array<{ code: string; flat: string; nested: string }>
  }
  messages: Record<string, unknown>
  codec_pairs: Array<{ id: string; message_ref: string; compact: string; note?: string }>
  link_urls: { accept: AcceptCase[]; reject: RejectCase[] }
  required_controls: { ids: Array<{ id: string; why: string }> }
  resolve: ResolveCase[]
}

const fixtureSource = readFileSync(FIXTURE_PATH, "utf8")
const fx = JSON.parse(fixtureSource) as Fixture

/**
 * Report any key the runner does not consume. An unrecognised key is a failure,
 * not a skip: a case gaining an expectation this runner silently ignores is a
 * green test that stopped checking something.
 */
function assertNoUnhandledKeys(id: string, obj: Record<string, unknown>, consumed: string[]): void {
  const unhandled = Object.keys(obj).filter((k) => !consumed.includes(k))
  expect({ id, unhandled }).toEqual({ id, unhandled: [] })
}

// --- resolver + fetch stubs ------------------------------------------------

/**
 * What the mocked resolver answers for the call in flight. Set immediately
 * before each resolve, which is the same per-call shape the Go runner uses.
 * `assertPublicTarget` runs twice per accepted resolve (once before the fetch,
 * once after) and both reads see this value.
 */
let currentAnswers: string[] = [PUBLIC_STUB_ADDRESS]

/**
 * Delivers the fixture's `resolves_to` answers verbatim, so no case in this
 * file touches the network. It reads `currentAnswers` on each call rather than
 * closing over a per-case list: a reject case is resolved twice (once before
 * the fetch, once after) and both reads must see the value the case set.
 */
const hostResolver: HostResolver = async () => currentAnswers

beforeEach(() => {
  currentAnswers = [PUBLIC_STUB_ADDRESS]
})

function answersFor(c: RejectCase): string[] {
  if (c.resolves_to !== undefined && c.resolves_to.length > 0) return c.resolves_to
  // A name the fixture marks `local_name` gets loopback, which is what it
  // answers on every real machine.
  if (c.local_name === true) return ["127.0.0.1"]
  return [PUBLIC_STUB_ADDRESS]
}

interface FetchStub {
  calls: number
  /** The URL the resolver actually requested, as it handed it to fetch. */
  requested: string | null
  fetch: typeof fetch
}

function stubFetch(status: number, headers: Record<string, string>, bytes: Uint8Array): FetchStub {
  const stub: FetchStub = {
    calls: 0,
    requested: null,
    fetch: (async (input: unknown) => {
      stub.calls += 1
      stub.requested = typeof input === "string" ? input : String(input)
      return {
        ok: status >= 200 && status < 300,
        status,
        type: "basic",
        headers: new Headers(headers),
        body: null,
        text: () => Promise.resolve(new TextDecoder().decode(bytes)),
        arrayBuffer: () =>
          Promise.resolve(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      } as unknown as Response
    }) as unknown as typeof fetch,
  }
  return stub
}

/**
 * A fetch that must never be called.
 *
 * The thrown message is a sentinel the reject runner looks for, because a stub
 * that merely throws turns an ACCEPTED URL into a rejected promise: the runner
 * would then report "rejected" for a case that got past every pre-flight rule.
 * Reaching this function is an acceptance, and is reported as one.
 */
const REACHED_THE_NETWORK = "conformance-stub: a rejected URL must cost zero requests"

function noFetch(): FetchStub {
  const stub: FetchStub = {
    calls: 0,
    requested: null,
    fetch: (async (input: unknown) => {
      stub.calls += 1
      stub.requested = typeof input === "string" ? input : String(input)
      throw new Error(REACHED_THE_NETWORK)
    }) as unknown as typeof fetch,
  }
  return stub
}

/**
 * An envelope carrying the given payload.endpoint. Built by this side's own
 * encoder: what the fixture supplies for an accept case is the URL and the
 * endpoint it derives, not a response body.
 */
function requestWithEndpoint(endpoint: string): IPPRequest {
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

function jsonBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

// --- the fixture copy itself -----------------------------------------------

describe("the vendored fixture copy", () => {
  it("is the file this runner was written against", () => {
    expect(fx.spec).toBe("06-ipp/6.6-transport-bindings.md")
    expect(fx.ipp_version).toBe(1)
    expect(fx.fixture_version).toBeGreaterThanOrEqual(9)
  })

  it("still carries every case the fixture declares mandatory", () => {
    // The point of the list is that a MISSING positive control leaves a hole no
    // per-rule count reports: "reject any address with two equal zero runs"
    // passes every reject case in the file on its own.
    const present = new Set<string>([
      ...fx.link_urls.accept.map((c) => c.id),
      ...fx.link_urls.reject.map((c) => c.id),
      ...fx.resolve.map((c) => c.id),
    ])
    const missing = fx.required_controls.ids.filter((r) => !present.has(r.id)).map((r) => r.id)
    expect(missing).toEqual([])
  })

  it("keeps every input string printable ASCII", () => {
    // The reject cases that carry an invisible character supply it as
    // `url_template` + `codepoint` for exactly this reason: a literal U+200B or
    // U+FEFF in a JSON file is one an editor doing Unicode normalization deletes
    // on save, which leaves the case green and its rule unguarded. A literal
    // appearing here means that happened in reverse -- someone inlined one.
    const offenders: string[] = []
    const check = (id: string, field: string, value: string | undefined): void => {
      if (value === undefined) return
      for (const ch of value) {
        const cp = ch.codePointAt(0) ?? 0
        if (cp < 0x21 || cp > 0x7e) {
          offenders.push(`${id}.${field}=U+${cp.toString(16).padStart(4, "0")}`)
        }
      }
    }
    for (const c of fx.link_urls.accept) {
      check(c.id, "url", c.url)
      check(c.id, "endpoint", c.endpoint)
      check(c.id, "token", c.token)
    }
    for (const c of fx.link_urls.reject) {
      check(c.id, "url", c.url)
      check(c.id, "url_template", c.url_template)
    }
    expect(offenders).toEqual([])
  })

  it("keeps this test file pure ASCII", () => {
    // Same failure as above, one layer out: every code point under test comes
    // from the fixture, so a non-ASCII character in this source can only be a
    // literal someone typed -- and a formatter is free to delete it.
    const src = readFileSync(`${HERE}link.conformance.test.ts`, "utf8")
    const offenders = [...src]
      .filter((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)
      .map((ch) => (ch.codePointAt(0) ?? 0).toString(16))
    expect(offenders).toEqual([])
  })
})

// --- link_urls.accept ------------------------------------------------------

describe("link_urls.accept", () => {
  it("has cases", () => {
    expect(fx.link_urls.accept.length).toBeGreaterThan(0)
  })

  for (const c of fx.link_urls.accept) {
    it(`accepts ${c.id}`, async () => {
      assertNoUnhandledKeys(c.id, c as unknown as Record<string, unknown>, [
        "id",
        "url",
        "token",
        "endpoint",
        "note",
      ])
      // The served payload.endpoint is the endpoint the FIXTURE says this URL
      // derives. So rule 9 is a second, independent check on the same
      // expectation: derive anything else and the cross-check refuses.
      const stub = stubFetch(
        200,
        { "Content-Type": "application/json" },
        jsonBytes(encodeIPPRequest(requestWithEndpoint(c.endpoint), "json")),
      )
      const { endpoint } = await link.resolveIPPLink(c.url, { fetch: stub.fetch, hostResolver })
      expect(endpoint).toBe(c.endpoint)
      expect(stub.calls).toBe(1)
      // The URL goes out AS SCANNED, byte for byte. Only the derived endpoint is
      // normalized, because only it is compared. The two SDKs disagreed here
      // until 6.6 pinned it: the Go side rebuilt the request from the normal
      // form, so "https://Pay.Example.COM:443/..." left as
      // "https://pay.example.com/...", and the receiver's access log held a
      // different line than this side produced for one QR code.
      //
      // This also covers the token, which is the one part of the URL that is
      // neither case-folded nor percent-decoded (the fixture pins
      // case_sensitive_token): repairing it would request a resource that does
      // not exist while every other assertion here still passed.
      expect({ id: c.id, requested: stub.requested }).toEqual({ id: c.id, requested: c.url })
      expect({ id: c.id, endsInToken: c.url.endsWith(`/ipp/v1/link/${c.token}`) }).toEqual({
        id: c.id,
        endsInToken: true,
      })
    })
  }
})

// --- link_urls.reject ------------------------------------------------------

/** The case's URL, substituting {CP} with the declared code point. */
function rejectInput(c: RejectCase): string {
  const hasUrl = typeof c.url === "string" && c.url !== ""
  const hasTemplate = typeof c.url_template === "string" && c.url_template !== ""
  if (hasUrl && hasTemplate) throw new Error(`${c.id}: carries both url and url_template`)
  if (hasUrl) return c.url as string
  if (!hasTemplate) throw new Error(`${c.id}: carries neither url nor url_template`)
  const template = c.url_template as string
  if (typeof c.codepoint !== "number") throw new Error(`${c.id}: url_template with no codepoint`)
  if (!template.includes("{CP}")) throw new Error(`${c.id}: url_template has no {CP} slot`)
  return template.replace("{CP}", String.fromCodePoint(c.codepoint))
}

describe("link_urls.reject", () => {
  it("has cases", () => {
    expect(fx.link_urls.reject.length).toBeGreaterThan(0)
  })

  for (const c of fx.link_urls.reject) {
    it(`rejects ${c.id}`, async () => {
      assertNoUnhandledKeys(c.id, c as unknown as Record<string, unknown>, [
        "id",
        "url",
        "url_template",
        "codepoint",
        "rule",
        "rejected_by",
        "reason",
        "malicious",
        "isolates",
        "requires",
        "resolves_to",
        "local_name",
      ])
      currentAnswers = answersFor(c)
      const stub = noFetch()
      const outcome = await link
        .resolveIPPLink(rejectInput(c), { fetch: stub.fetch, hostResolver })
        .then(() => "accepted" as const)
        .catch((err: unknown) =>
          String(err).includes(REACHED_THE_NETWORK) ? ("accepted" as const) : ("rejected" as const),
        )
      expect({ id: c.id, outcome }).toEqual({ id: c.id, outcome: "rejected" })
      // reject_contract.http_calls_expected is 0 for every case in this section:
      // rules 1, 2 and 4 all decide before the first byte leaves the process. A
      // rejection that cost a request means a check moved below the fetch, which
      // turns "scan any QR code" into "GET any URL".
      expect({ id: c.id, calls: stub.calls }).toEqual({ id: c.id, calls: 0 })
    })
  }
})

// --- host_policy.public_addresses -----------------------------------------

/**
 * The half of rule 4 a reject-only suite cannot see. Every one of these
 * addresses sits immediately outside a blocked prefix, so a prefix written one
 * bit too wide -- 192.0.0.0/24 typed as /16, CGNAT typed as 100/8 -- still
 * refuses every MUST-REJECT case in the file and only shows up here. That exact
 * widening really shipped on this side, and it survived two rounds of reading
 * the list against the prose because the list, the comment and the report all
 * said /24 while the code said /16.
 */
describe("host_policy.public_addresses", () => {
  // Borrowed from the fixture rather than declared here: a token spelled in this
  // file could drift out of the grammar the fixture pins.
  const token = fx.link_urls.accept.find((c) => c.token !== undefined)?.token

  it("has cases and a token to build them with", () => {
    expect(fx.host_policy.public_addresses.length).toBeGreaterThan(0)
    expect(token).toBeDefined()
  })

  for (const pub of fx.host_policy.public_addresses) {
    it(`treats ${pub.address} as public`, async () => {
      const authority = pub.address.includes(":") ? `[${pub.address}]` : pub.address
      const expected = `https://${authority}`
      const stub = stubFetch(
        200,
        { "Content-Type": "application/json" },
        jsonBytes(encodeIPPRequest(requestWithEndpoint(expected), "json")),
      )
      const { endpoint } = await link.resolveIPPLink(
        `${expected}/ipp/v1/link/${token ?? ""}`,
        { fetch: stub.fetch, hostResolver },
      )
      expect({ address: pub.address, endpoint }).toEqual({ address: pub.address, endpoint: expected })
    })
  }
})

// --- codec_pairs -----------------------------------------------------------

describe("codec_pairs", () => {
  for (const pair of fx.codec_pairs) {
    it(`decodes ${pair.id} to the same envelope as its JSON form`, () => {
      const ref = fx.messages[pair.message_ref]
      expect(ref).toBeDefined()
      const want = decodeIPPRequest(JSON.stringify(ref))
      // Value, never the re-encoded string: MessagePack map ordering is
      // implementation-defined, so a byte comparison would fail for a reason
      // that is not a divergence.
      expect(decodeIPPRequest(pair.compact)).toEqual(want)
    })
  }
})

// --- resolve ---------------------------------------------------------------

/**
 * The response body, from whichever of the five carriers the case uses. Hex is
 * one of them for a reason: the BOM and the leading-byte rules are decided on
 * BYTES, and handing the resolver an already-decoded string skips the layer
 * where a decoder strips the BOM -- which is the layer under test.
 *
 * The key check matters here specifically: validate.mjs accepts a
 * body_text_template carrier this runner did not originally handle, so a case
 * using it would have been fed an EMPTY body, rejected for that reason, and
 * reported as a pass for the rule it names.
 */
function resolveBody(c: ResolveCase): Uint8Array {
  const r = c.response
  const known = [
    "status",
    "headers",
    "body_json_ref",
    "body_json",
    "body_text",
    "body_text_template",
    "body_bytes_hex",
    "codepoint",
  ]
  const unhandled = Object.keys(r).filter((k) => !known.includes(k))
  if (unhandled.length > 0) {
    throw new Error(
      `${c.id}: response carries key(s) ${unhandled.join(", ")} this runner does not handle; ` +
        "a body it cannot read is an empty body, and an empty body is refused for the wrong reason",
    )
  }
  const forms: Uint8Array[] = []
  if (r.body_json_ref !== undefined) {
    const msg = fx.messages[r.body_json_ref]
    if (msg === undefined) throw new Error(`${c.id}: body_json_ref ${r.body_json_ref} not in fixture`)
    forms.push(jsonBytes(JSON.stringify(msg)))
  }
  if (r.body_json !== undefined) forms.push(jsonBytes(JSON.stringify(r.body_json)))
  if (r.body_text !== undefined) forms.push(jsonBytes(r.body_text))
  if (r.body_text_template !== undefined) {
    if (typeof r.codepoint !== "number") {
      throw new Error(`${c.id}: body_text_template with no codepoint`)
    }
    if (!r.body_text_template.includes("{CP}")) {
      throw new Error(`${c.id}: body_text_template has no {CP} slot`)
    }
    forms.push(jsonBytes(r.body_text_template.replace("{CP}", String.fromCodePoint(r.codepoint))))
  }
  if (r.body_bytes_hex !== undefined) {
    const hex = r.body_bytes_hex
    if (hex.length % 2 !== 0) throw new Error(`${c.id}: body_bytes_hex has an odd length`)
    const out = new Uint8Array(hex.length / 2)
    for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    forms.push(out)
  }
  if (forms.length > 1) {
    throw new Error(`${c.id}: declares ${forms.length} response bodies; one or none is allowed`)
  }
  return forms[0] ?? new Uint8Array(0)
}

/** The machine code an error surfaced, or null when it surfaced none. */
function errorCodeOf(err: unknown): string | null {
  const code = (err as { code?: unknown }).code
  return typeof code === "string" && code !== "" ? code : null
}

/** The HTTP status an error carries, or 0. */
function statusOf(err: unknown): number {
  const status = (err as { statusCode?: unknown }).statusCode
  return typeof status === "number" ? status : 0
}

describe("resolve", () => {
  it("has cases", () => {
    expect(fx.resolve.length).toBeGreaterThan(0)
  })

  for (const c of fx.resolve) {
    it(`${c.id}`, async () => {
      assertNoUnhandledKeys(c.id, c as unknown as Record<string, unknown>, [
        "id",
        "url",
        "response",
        "expect",
        "malicious",
      ])
      const stub = stubFetch(c.response.status, c.response.headers ?? {}, resolveBody(c))
      let request: IPPRequest | null = null
      let endpoint: string | null = null
      let err: unknown = null
      try {
        const out = await link.resolveIPPLink(c.url, { fetch: stub.fetch, hostResolver })
        request = out.request
        endpoint = out.endpoint
      } catch (caught) {
        err = caught
      }

      const outcome = c.expect["outcome"]
      if (outcome === "accept") {
        expect({ id: c.id, err: err === null ? null : String(err) }).toEqual({ id: c.id, err: null })
      } else if (outcome === "reject") {
        expect({ id: c.id, rejected: err !== null }).toEqual({ id: c.id, rejected: true })
      } else {
        throw new Error(`${c.id}: unknown outcome ${String(outcome)}`)
      }

      for (const [key, value] of Object.entries(c.expect)) {
        switch (key) {
          case "outcome":
            break

          case "endpoint":
            expect({ id: c.id, endpoint }).toEqual({ id: c.id, endpoint: value })
            break

          case "message_ref": {
            const msg = fx.messages[value as string]
            if (msg === undefined) throw new Error(`${c.id}: message_ref ${String(value)} not in fixture`)
            expect(request).toEqual(decodeIPPRequest(JSON.stringify(msg)))
            break
          }

          case "envelope_expired": {
            if (value !== true) throw new Error(`${c.id}: envelope_expired must be true or absent`)
            // Neither SDK carries a dedicated expiry signal out of the resolve.
            // What both do deliver is meta.expiresAt intact, which is what a
            // caller needs to warn before display. Asserting that keeps the case
            // honest: drop `meta` on the way through and this goes red.
            const at = request?.meta?.["expiresAt"]
            expect(typeof at).toBe("string")
            const parsed = Date.parse(at as string)
            expect(Number.isNaN(parsed)).toBe(false)
            expect(parsed).toBeLessThan(Date.now())
            break
          }

          case "rule": {
            // The verdict is what this file compares across implementations, but
            // WHEN a rule fires is also observable without naming it: rules 1, 2
            // and 4 decide before any I/O, so they cost zero requests, and
            // everything from rule 6 on has to have read a response first.
            const preflight = value === 1 || value === 2 || value === 4
            expect({ id: c.id, rule: value, calls: stub.calls }).toEqual({
              id: c.id,
              rule: value,
              calls: preflight ? 0 : 1,
            })
            break
          }

          case "error_code":
            expect({ id: c.id, code: errorCodeOf(err) }).toEqual({ id: c.id, code: value })
            break

          case "error_code_absent": {
            if (value !== true) throw new Error(`${c.id}: error_code_absent must be true or absent`)
            // The other half of the shape negotiation. Both envelope shapes are
            // accepted, so the boundary has to be pinned too: a body matching
            // NEITHER must not become an envelope error at all.
            //
            // The assertion is "not an IppError", NOT "surfaced no code" -- those
            // are different, and the weaker one is a false green. MEASURED on the
            // Go side: widening the flat reading to any object carrying a
            // `message` types this body with code "", which "surfaced no code"
            // reads as a pass. An empty code is exactly what must not be
            // manufactured: the caller cannot tell it from a code the SDK failed
            // to read.
            const typed = err instanceof errorsMod.IppError
            expect({
              id: c.id,
              typedEnvelopeError: typed,
              code: typed ? (err as { code: string }).code : null,
            }).toEqual({ id: c.id, typedEnvelopeError: false, code: null })
            break
          }

          case "http_status":
            expect({ id: c.id, status: statusOf(err) }).toEqual({ id: c.id, status: value })
            break

          case "reason":
          case "note":
            // Prose for a human reading the fixture. There is nothing to assert
            // and pretending otherwise would be the false green this file exists
            // to remove.
            break

          default:
            // resolve_contract.unknown_expect_key: an expectation this runner
            // does not understand must fail loudly, never be skipped.
            throw new Error(
              `${c.id}: expect key "${key}" is one this runner does not handle; handle it or the case is asserting less than it says`,
            )
        }
      }
    })
  }
})

// --- envelope.error_envelope_shape_pairs -----------------------------------

/**
 * One machine code, arriving intact through BOTH accepted error-envelope shapes.
 *
 * Asserting each case against its own literal leaves "both happen to be spelled
 * link_not_found" as a coincidence in the fixture rather than a property a runner
 * checks. It is the pair that is the control: a reader understanding only one
 * shape passes every case written in that shape, which is exactly how the
 * nested-only reading survived here while dropping the machine code of every
 * answer a third-party resolver sends in 6.2's flat shape.
 *
 * The third pair carries an unrecognized code, because widening the accepted
 * SHAPES must not widen anything about the code: it stays an open string,
 * surfaced verbatim, never mapped onto a known one and never turned into a
 * rejection of its own.
 */
describe("envelope.error_envelope_shape_pairs", () => {
  const pairs = fx.envelope.error_envelope_shape_pairs
  const byId = new Map(fx.resolve.map((c) => [c.id, c]))

  it("has pairs", () => {
    expect(pairs.length).toBeGreaterThan(0)
  })

  async function codeFor(id: string): Promise<string | null> {
    const c = byId.get(id)
    if (c === undefined) throw new Error(`pair names case "${id}", which is not in the fixture`)
    const stub = stubFetch(c.response.status, c.response.headers ?? {}, resolveBody(c))
    const err = await link
      .resolveIPPLink(c.url, { fetch: stub.fetch, hostResolver })
      .then(() => null)
      .catch((caught: unknown) => caught)
    if (err === null) throw new Error(`case ${id} was accepted; an error envelope must be refused`)
    return errorCodeOf(err)
  }

  for (const pair of pairs) {
    it(`surfaces ${pair.code} through both envelope shapes`, async () => {
      const flat = await codeFor(pair.flat)
      const nested = await codeFor(pair.nested)
      // One object, so a mismatch prints both sides and which shape lost the code.
      expect({ flat, nested, expected: pair.code }).toEqual({
        flat: pair.code,
        nested: pair.code,
        expected: pair.code,
      })
    })
  }
})
