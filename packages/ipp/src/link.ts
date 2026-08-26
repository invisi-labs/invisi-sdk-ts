// === IPP short-link transport binding -- payer-side resolution ===
//
// A receive QR may carry `https://<endpoint>/ipp/v1/link/<link_token>` instead
// of the self-contained `ipp1:<base64url(msgpack)>` string. This module is the
// ONLY place the payer-side safety rules live: third parties get them by
// installing the package, so nothing here may be re-derived by a consumer.
//
// The rules are load-bearing for a design decision made elsewhere: the resolved
// IPPMessage is NOT signed. That is only defensible because (a) the JSON is
// served by the very host the payer will `propose` to -- hence redirects are
// refused -- and (b) the endpoint inside the payload must equal the one derived
// from the link URL. Weaken either and an unsigned payload becomes forgeable in
// transit by a host the payer never chose.

import { decodeIPPRequest } from "./codec"
import { ConnectionError, ippErrorFromEnvelope } from "./errors"
import type { IPPRequest } from "./types"

/** Tuning knobs for {@link resolveIPPLink}. All optional. */
export interface ResolveIPPLinkOptions {
  /** Injected fetch (tests, custom transports). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch
  /** Whole-request deadline in milliseconds. Default 10000. */
  timeoutMs?: number
  /** Hard cap on the response body in bytes. Default 65536. */
  maxBytes?: number
}

export interface ResolvedIPPLink {
  /** The resolved payment request -- same schema and same parser as `ipp1:`. */
  request: IPPRequest
  /** Server root derived from the link URL; feed it to `new IPPClient(endpoint)`. */
  endpoint: string
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 64 * 1024

/** `<scheme>://<authority><path>` with no query and no fragment anywhere. */
const WIRE_URL_RE = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)(\/[^?#]*)?$/

/** Trailing `/ipp/v1/link/<22-char base64url>`; group 1 is the endpoint path prefix. */
const LINK_PATH_RE = /^(.*)\/ipp\/v1\/link\/([A-Za-z0-9_-]{22})$/

/**
 * Every code point refused anywhere in a URL, enumerated one member at a time.
 *
 * Deliberately does NOT use `\s`. That set is defined by the engine's Unicode
 * version -- its Zs tail moves between releases, and U+180E is a member on an
 * engine shipping Unicode 6.2 and not on a newer one -- so any rule leaning on
 * it makes membership an environment question rather than a wire question.
 * The list below is the rule; nothing here is supplied by the runtime.
 *
 * Members, in the order the rule states them: C0, DEL, C1, U+FEFF, U+0020,
 * U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000.
 * U+FEFF and the C1 block are the two that a naive whitespace set gets wrong in
 * opposite directions (JS whitespace contains U+FEFF and not U+0085; Go's
 * contains U+0085 and not U+FEFF).
 *
 * Every `-` here sits between two explicit \u escapes. A stray one beside a
 * literal character would form a silent range: an earlier revision read
 * /[\s -]/, whose trailing `-` is a literal, and it refused every URL
 * containing a hyphen -- about half of all base64url tokens.
 */
const CONTROL_OR_SPACE_RE =
  /[\u0000-\u001f\u0020\u007f\u0080-\u009f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/

/**
 * One path segment, as RFC 3986 `pchar`: unreserved / pct-encoded /
 * sub-delims / ":" / "@". The `-` is escaped, so it is a literal and not a
 * range endpoint; every other `-` here bounds an alphanumeric range.
 *
 * This is the path's spelling rule, and it is deliberately a character set
 * rather than "must equal what the local parser normalizes it to". The latter
 * cannot be a wire rule: its judge is whichever parser is running, and two
 * parsers normalize differently (`|` and `^` survive here and are rewritten to
 * %7C / %5E elsewhere; a lone `%` survives here and is a parse error elsewhere).
 */
const PCHAR_SEGMENT_RE = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*$/

/**
 * A well-formed percent escape, capturing its two hex digits.
 *
 * Case is a separate rule from well-formedness on purpose: `%2f` is a perfectly
 * good pchar escape, so the shape check cannot see it, and rule 9 is a string
 * comparison while RFC 3986 section 6.2.2.1 says to uppercase pct escapes
 * before comparing. Both readings are defensible, and they disagree: a link
 * deriving `.../a%41%2Fb` against a payload.endpoint written `.../a%41%2fb` is
 * refused by strict equality and paid after normalization. Refused, not
 * normalized -- same direction as scheme, port and IPv6.
 */
const PCT_ESCAPE_RE = /%([0-9A-Fa-f]{2})/g

/** One DNS label's character set: letters, digits, hyphens (RFC 1123). */
const LDH_LABEL_RE = /^[A-Za-z0-9-]+$/

/** RFC 1035 2.3.4: a label is at most 63 octets. */
const MAX_LABEL_LENGTH = 63

/** Host made only of digits and dots: an IPv4 literal attempt, canonical or not. */
const DOTTED_NUMERIC_RE = /^[0-9.]+$/

/** Highest legal TCP port. */
const MAX_PORT = 65535

/** Any code point outside ASCII. Both `-` sit between explicit escapes. */
const NON_ASCII_RE = /[^\u0000-\u007f]/

/** A port as it must be written: decimal, no leading zero, not empty. */
const CANONICAL_PORT_RE = /^[1-9][0-9]*$/

/** Endpoint path prefix: one or more non-empty segments, or nothing at all. */
const PATH_PREFIX_RE = /^(\/[^/]+)+$/

/**
 * Names that can only mean the local machine or the local network. Used ONLY on
 * runtimes with no DNS API (browsers) -- see `assertPublicTarget`. On Node the
 * decision is made on resolved addresses instead, which subsumes this list.
 */
const LOCAL_NAME_RE = /^(localhost|.+\.localhost|.+\.local|.+\.internal|.+\.localdomain|.+\.home\.arpa)$/

/**
 * Resolve a scanned IPP short link into the payment request it points at.
 *
 * Enforces, in order: URL shape + `https`, normalization (no userinfo / query /
 * fragment), endpoint derivation, non-private target, anonymous request, no
 * redirect following, size + time caps, `validateIPPRequest`, and finally the
 * endpoint cross-check.
 *
 * @throws Error for any rule violation, {@link ConnectionError} for transport
 * failures, and the typed {@link IppError} subclasses for a server error envelope.
 */
export async function resolveIPPLink(
  linkUrl: string,
  opts?: ResolveIPPLinkOptions,
): Promise<ResolvedIPPLink> {
  return resolve(linkUrl, opts, false)
}

/**
 * Same as {@link resolveIPPLink} but also accepts `http` and targets on
 * loopback / private / link-local addresses. For local deployments and dev
 * builds only.
 *
 * This is a separate export rather than a flag because "do not pass true in
 * release" is unenforceable, while an import name is greppable and can be
 * banned outright -- `invisi-pay-web` / `invisi-pay-app` do exactly that with
 * ESLint `no-restricted-imports`. Renaming it silently disarms that guard.
 */
export async function resolveIPPLinkUnsafe(
  linkUrl: string,
  opts?: ResolveIPPLinkOptions,
): Promise<ResolvedIPPLink> {
  return resolve(linkUrl, opts, true)
}

// ---------------------------------------------------------------------------

async function resolve(
  linkUrl: string,
  opts: ResolveIPPLinkOptions | undefined,
  allowInsecure: boolean,
): Promise<ResolvedIPPLink> {
  // Rules 1-4 run before any I/O, and must stay there. Moving any of them below
  // the fetch turns "scan any QR code" into "issue a GET to any URL an attacker
  // printed" -- the injected fetch in link.test.ts asserts zero calls for each
  // rejected shape precisely because that ordering is the whole control.
  const { host, endpoint } = parseLinkUrl(linkUrl, allowInsecure)

  // Rule 4 -- decided on resolved addresses, not on the literal host.
  if (!allowInsecure) await assertPublicTarget(host)

  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  const fetchImpl = opts?.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== "function") {
    throw new Error("resolveIPPLink: no fetch implementation available (pass opts.fetch)")
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res: Response
  let bytes: Uint8Array
  try {
    try {
      // The URL as scanned, not a parser's re-rendering of it -- same reason
      // the endpoint is built from the written string. This one also lands in
      // the receiver's access log, where a rewritten host would be a puzzle.
      res = await fetchImpl(linkUrl, {
        method: "GET",
        // Rule 5 -- anonymous. Accept is a CORS-safelisted header, so this stays
        // a simple request and needs no preflight on the wide-open /ipp/v1 face.
        // Nothing else may be added here: any extra header fingerprints the wallet.
        headers: { Accept: "application/json" },
        // Rule 6 -- the JSON representation must come from the link's own host.
        redirect: "manual",
        credentials: "omit",
        mode: "cors",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      })
    } catch (cause) {
      throw new ConnectionError(
        controller.signal.aborted
          ? `IPP link request timed out after ${timeoutMs}ms`
          : cause instanceof Error
            ? cause.message
            : "network request failed",
        { cause },
      )
    }

    // Rule 6. Node/undici hands back the real 3xx; a browser that refused to
    // follow one hands back an opaque response instead.
    const kind = (res as { type?: string }).type
    if (kind === "opaqueredirect") {
      throw new Error(
        "IPP link resolution refused to follow a redirect (opaque redirect response); " +
          "the JSON representation must be served by the link's own host",
      )
    }
    if (res.status >= 300 && res.status < 400) {
      throw new Error(
        `IPP link resolution refused to follow a redirect (HTTP ${res.status}); ` +
          "the JSON representation must be served by the link's own host",
      )
    }
    if (res.status === 0) {
      // Status 0 without the opaqueredirect marker means the response was
      // opaque or blocked for some other reason (CORS, an extension). Calling
      // it a redirect would state a cause we cannot actually distinguish.
      throw new ConnectionError(
        "IPP link response carried no HTTP status (opaque or blocked response)",
      )
    }

    bytes = await readBodyBytes(res, maxBytes)
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    // Rule 10 -- reuse the one envelope parser so link errors surface as the
    // same typed classes as every other /ipp/v1 call.
    // The error envelope is the 6.2 contract, not the IPP message body, so it
    // goes through an ordinary decode -- the byte-level rules below apply to
    // the representation that carries a payment request.
    let body: unknown
    try {
      body = JSON.parse(new TextDecoder().decode(bytes))
    } catch (cause) {
      throw new ConnectionError(
        `IPP link error response body was not valid JSON (HTTP ${res.status})`,
        { statusCode: res.status, cause },
      )
    }
    const err = ippErrorFromEnvelope(body, res.status)
    if (err === null) {
      throw new ConnectionError(
        `IPP link error response did not contain an error envelope (HTTP ${res.status})`,
        { statusCode: res.status },
      )
    }
    throw err
  }

  // Rule 8 -- same decoder as the `ipp1:` carrier, so both carriers are proven
  // to produce one shape by construction rather than by two parallel parsers.
  // It runs validateIPPRequest internally and rejects a voucher envelope.
  const request = decodeLinkBody(bytes)

  // Rule 4 again. fetch exposes no hook to pin the socket to the address we
  // checked, so a name that answered "public" a moment ago can have answered
  // something internal by the time undici connected. Re-checking here cannot
  // un-send the request, but it does stop an internal response from being
  // handed to the caller as a payment request.
  if (!allowInsecure) await assertPublicTarget(host)

  // Rule 9 -- the nail that welds the short link to the protocol. A malformed
  // payload.endpoint throws from normalizeEndpoint with its own reason; only a
  // well-formed one that disagrees reaches the mismatch below.
  const declared = normalizeEndpoint(request.payload.endpoint, allowInsecure)
  if (declared !== endpoint) {
    throw new Error(
      `IPP link endpoint mismatch: link URL derives "${endpoint}" but payload.endpoint is ` +
        `"${request.payload.endpoint ?? "<missing>"}"`,
    )
  }

  return { request, endpoint }
}

// --- Rules 1-3: shape, normalization, endpoint derivation -------------------

const DOT_SEGMENT_RE = /^(\.|%2e){1,2}$/i

function hasDotSegment(rawPath: string): boolean {
  return rawPath.split("/").some((seg) => DOT_SEGMENT_RE.test(seg))
}

/** Top-level keys the IPP envelope is allowed to carry (`06-ipp/6.1 section "JSON format"`). */
const ENVELOPE_KEYS = new Set(["v", "network", "type", "meta", "payload"])

/** RFC 8259 section 2 whitespace, as bytes. Nothing else counts as whitespace here. */
const JSON_WS_BYTES = new Set([0x20, 0x09, 0x0a, 0x0d])

/**
 * Parse the link response body into an IPPRequest.
 *
 * Takes BYTES, and that is the point. The rule is "strip leading RFC 8259
 * whitespace, then the first character must be `{`", and every layer above the
 * bytes has its own opinion about what leads that body:
 *
 *   - `.trim()` strips U+FEFF and keeps U+0085; Go's TrimSpace does the
 *     opposite. Same two code points W1 had to pin for URLs.
 *   - The decoders disagree before that even matters: `TextDecoder` and
 *     `Response.text()` DELETE a leading BOM, while `Buffer.toString("utf8")`
 *     and Go's `string(b)` keep it. So a body of `EF BB BF 7B ...` reaches a
 *     code-point-level check as `{...}` in a browser and as `\uFEFF{...}` in Go
 *     -- one wallet pays, the other refuses, both implementing the rule
 *     faithfully. Middleboxes prepend BOMs to JSON often enough for this to be
 *     a real code, not a hypothetical one.
 *
 * So: judge the bytes, then decode. Never `.text()` before this point.
 */
function decodeLinkBody(bytes: Uint8Array): IPPRequest {
  // RFC 8259 section 8.1 forbids a BOM outright, so this is a flat refusal
  // rather than something to skip over.
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(
      "Invalid IPP link response: body must not begin with a UTF-8 BOM (EF BB BF)",
    )
  }
  // Well-formedness is checked on the bytes, before anything decodes them,
  // because the decoder is lossy and would destroy the evidence: TextDecoder is
  // non-fatal by default, so 0xFF becomes U+FFFD and JSON.parse then succeeds
  // -- and 0xFE becomes the SAME character, which means two keys that differ on
  // the wire can arrive identical. Every rule below this line judges decoded
  // text, and requiring well-formed input is what makes that safe: the decode
  // becomes lossless, so it stops mattering which layer those rules sit on.
  if (!isWellFormedUTF8(bytes)) {
    throw new Error(
      "Invalid IPP link response: body must be well-formed UTF-8 (RFC 8259 section 8.1)",
    )
  }
  let at = 0
  while (at < bytes.length && JSON_WS_BYTES.has(bytes[at] ?? -1)) at += 1
  if (bytes[at] !== 0x7b) {
    throw new Error(
      "Invalid IPP link response: body must be a bare JSON IPPMessage " +
        '(the compact "ipp1:" form is not a valid link representation)',
    )
  }

  // Decoded from the `{`, not from byte 0: the leading whitespace is legal per
  // RFC 8259 but the shared decoder requires the text to start at the brace, so
  // keeping it would refuse a body this rule just accepted.
  const text = new TextDecoder().decode(bytes.subarray(at))
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new ConnectionError("IPP link response body was not valid JSON", { cause })
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid IPP link response: body must be a JSON object")
  }

  // All three key rules are decided on the LITERAL SPELLING, never on the parsed
  // object. `{"\u0076":1,...}` is the case that forces it -- \u0076 IS v -- so
  // parsing first puts the key inside the closed set and folds a duplicate away,
  // while comparing raw spellings puts it outside the set: two implementations,
  // opposite verdicts, both following "the key must be one of five". Refusing
  // the escape outright removes the unescaping step and with it the choice of
  // layer. No real server spells v that way.
  const written = topLevelKeys(text)
  const seen = new Set<string>()
  for (const key of written) {
    if (key.includes("\\")) {
      throw new Error(
        `Invalid IPP link response: top-level key "${key}" must not contain a backslash escape`,
      )
    }
    if (!ENVELOPE_KEYS.has(key)) {
      throw new Error(
        `Invalid IPP link response: unexpected top-level key "${key}"; ` +
          "the envelope carries only v / network / type / meta / payload",
      )
    }
    if (seen.has(key)) {
      throw new Error(`Invalid IPP link response: duplicate top-level key "${key}"`)
    }
    seen.add(key)
  }
  // Same decoder as the `ipp1:` carrier from here on, so the two carriers
  // produce one shape by construction. It runs validateIPPRequest and rejects
  // a voucher envelope (a voucher carries nullifier_key and must never be
  // handed out by an anonymous public GET).
  return decodeIPPRequest(text)
}

/**
 * Whether `bytes` is well-formed UTF-8, per the Unicode table of well-formed
 * byte sequences: overlong encodings, surrogate halves and anything above
 * U+10FFFF are all ill-formed.
 *
 * Hand-written rather than `new TextDecoder("utf-8", { fatal: true })` for the
 * same reason the port range is checked here rather than left to a URL parser:
 * that would put the membership of "well-formed UTF-8" in the runtime's hands,
 * and this package ships to browsers and React Native, where a decoder shim
 * that ignores the `fatal` option would silently accept everything -- with the
 * suite still green, because the suite runs on Node.
 */
function isWellFormedUTF8(bytes: Uint8Array): boolean {
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0
    let trail: number
    let firstLow: number
    let firstHigh: number
    if (b0 <= 0x7f) {
      i += 1
      continue
    } else if (b0 >= 0xc2 && b0 <= 0xdf) {
      trail = 1
      firstLow = 0x80
      firstHigh = 0xbf
    } else if (b0 === 0xe0) {
      // E0 80..9F would be a two-byte value written overlong in three bytes.
      trail = 2
      firstLow = 0xa0
      firstHigh = 0xbf
    } else if (b0 === 0xed) {
      // ED A0..BF is D800..DFFF, a surrogate half, which is not a scalar value.
      trail = 2
      firstLow = 0x80
      firstHigh = 0x9f
    } else if ((b0 >= 0xe1 && b0 <= 0xec) || b0 === 0xee || b0 === 0xef) {
      trail = 2
      firstLow = 0x80
      firstHigh = 0xbf
    } else if (b0 === 0xf0) {
      // F0 80..8F would be overlong.
      trail = 3
      firstLow = 0x90
      firstHigh = 0xbf
    } else if (b0 >= 0xf1 && b0 <= 0xf3) {
      trail = 3
      firstLow = 0x80
      firstHigh = 0xbf
    } else if (b0 === 0xf4) {
      // F4 90.. would be above U+10FFFF.
      trail = 3
      firstLow = 0x80
      firstHigh = 0x8f
    } else {
      // C0/C1 (overlong two-byte forms), F5..FF (above U+10FFFF), and a bare
      // continuation byte 80..BF with no lead byte in front of it.
      return false
    }
    if (i + trail >= bytes.length) return false
    const first = bytes[i + 1] ?? 0
    if (first < firstLow || first > firstHigh) return false
    for (let k = 2; k <= trail; k += 1) {
      const b = bytes[i + k] ?? 0
      if (b < 0x80 || b > 0xbf) return false
    }
    i += trail + 1
  }
  return true
}

/**
 * The keys written at the top level of a JSON object, in order, duplicates kept.
 *
 * A parser cannot answer this: by the time it hands back an object the
 * duplicates are gone. Returned as WRITTEN -- quotes stripped, escapes left
 * alone. The caller refuses any spelling that contains an escape, so there is
 * nothing to unescape here and no layer to have to choose between.
 */
function topLevelKeys(text: string): string[] {
  const keys: string[] = []
  let depth = 0
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '"') {
      const start = i
      i += 1
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2
          continue
        }
        if (text[i] === '"') break
        i += 1
      }
      i += 1
      if (depth === 1) {
        let j = i
        // A byte set read off code points, which is exact here and only here:
        // all four values are ASCII, and JSON.parse already accepted this text,
        // so nothing else can sit between a key and its colon.
        while (j < text.length && JSON_WS_BYTES.has(text.charCodeAt(j))) j += 1
        if (text[j] === ":") {
          keys.push(text.slice(start + 1, i - 1))
        }
      }
      continue
    }
    if (ch === "{" || ch === "[") depth += 1
    else if (ch === "}" || ch === "]") depth -= 1
    i += 1
  }
  return keys
}

/**
 * One URL that satisfied every wire-form rule shared by both sides of the check.
 *
 * Every field is derived from the string as WRITTEN. Nothing here comes out of a
 * URL parser: `new URL` rewrites `[::ffff:1.2.3.4]` to `[::ffff:102:304]`, so
 * taking its output would make this implementation return an endpoint that no
 * other implementation produces -- and a third would produce a third spelling,
 * which is the class of hole this whole rule set exists to close. The spelling
 * rules narrow the written form down to exactly two sanctioned variations -- a
 * reg-name's letter case, and a port equal to the scheme's default -- and those
 * two are applied here.
 */
interface WireURL {
  /** The path exactly as written. */
  path: string
  /** The host as written, lowercased. An IPv6 literal keeps its brackets. */
  host: string
  /** `scheme://host[:port]`, built from the written string. */
  origin: string
}

/**
 * Every wire-form rule, in the one place both sides go through.
 *
 * The scanned link URL and `payload.endpoint` are compared to each other, so a
 * rule that guards only one of them guards neither. Two copies of these checks
 * is exactly how the endpoint side drifted once already: it had no dot-segment
 * and no backslash rule, so `https://h/api/../api` collapsed to `https://h/api`
 * under this parser and stayed as written under one that does not fold (Go's) --
 * the same printed code paying in one wallet and refused in the other.
 *
 * So: anything added below stays below. A rule that belongs to only one side
 * goes in that side's wrapper, and there are only two such rules -- the
 * `/ipp/v1/link/<token>` suffix on the link side, and trailing-slash stripping
 * on the endpoint side.
 *
 * `subject` only shapes the message; it must never change what is accepted.
 */
function parseWireURL(input: string, allowInsecure: boolean, subject: string): WireURL {
  const bad = (detail: string): Error => new Error(`Invalid ${subject}: ${detail}`)

  if (typeof input !== "string" || input.length === 0) {
    throw bad("expected a non-empty URL string")
  }
  // WHATWG URL strips leading/trailing whitespace and inline tab/newline before
  // parsing, so a string that only looks like a link after that stripping would
  // reach the network under a different spelling than the one shown to the user.
  if (CONTROL_OR_SPACE_RE.test(input)) {
    throw bad("URL contains whitespace or control characters")
  }

  const m = WIRE_URL_RE.exec(input)
  if (m === null) {
    throw bad(`URL must be "<scheme>://<host><path>" with no query or fragment, got "${input}"`)
  }
  const scheme = m[1] ?? ""
  const authority = m[2] ?? ""
  const rawPath = m[3] ?? ""

  // Compared as written, NOT lowercased first. Every other spelling on this
  // wire is refused rather than normalized -- port, host, path -- and RFC 3986
  // says a scheme is case-insensitive, so "normalize it" and "require it" are
  // both defensible readings of a rule that only names `https`. Two readings is
  // the whole problem: `HTTPS://pay.example.com/...` would be paid by one and
  // refused by the other. The host is the deliberate exception (accepted and
  // lowercased), because DNS is case-insensitive and payload.endpoint may
  // legitimately arrive uppercased.
  const allowed = allowInsecure ? ["https", "http"] : ["https"]
  if (!allowed.includes(scheme)) {
    throw bad(
      `scheme must be the lowercase literal ${allowed.map((x) => `"${x}"`).join(" or ")}, got "${scheme}"`,
    )
  }

  // `https://good.com@evil.com/...` derives the origin "good.com@evil.com" --
  // which the attacker controls on both sides, so the cross-check passes --
  // while the confirmation screen shows a host the user reads as good.com. That
  // is the last defence against an unsigned payload, so userinfo is refused
  // outright rather than stripped. This check stays ahead of the backslash one.
  if (authority.includes("@")) {
    throw bad("URL must not contain userinfo (the part before '@')")
  }
  if (authority.length === 0) {
    throw bad("URL has no host")
  }
  // WHATWG reads a backslash in the authority as a path separator, so
  // `https://good.example\evil.example/...` is host good.example here and host
  // good.example\evil.example under a parser that does not (Go's). Refusing it
  // keeps one written link from meaning two different origins.
  if (authority.includes("\\")) {
    throw bad("URL authority must not contain a backslash")
  }
  // ASCII-only. UTS-46 does not merely reject non-ASCII, it REWRITES it:
  // U+200B (ZWSP) and U+00AD (soft hyphen) are DELETED, so a URL written
  // `pay<U+200B>.example.com` is fetched as `pay.example.com` -- a host that is
  // not the one in the URL -- while the path still matches, so nothing
  // downstream notices. Punycode is the interoperable spelling for an IDN
  // endpoint: it needs no mapping, so every implementation reads it the same.
  if (NON_ASCII_RE.test(authority)) {
    throw bad(
      `URL authority must be ASCII only (use punycode for an IDN host), got "${authority}"`,
    )
  }
  // The port has to be written canonically rather than normalized, because the
  // two parsers normalize differently: ":0443" is dropped as a default port
  // here and kept verbatim by a parser that compares the port as a string.
  // ":443" / ":80" written exactly are still dropped -- that much both agree on.
  const port = writtenPort(authority)
  if (port !== null && !CANONICAL_PORT_RE.test(port)) {
    throw bad(
      `port must be written in canonical form -- no leading zeros, not empty -- got ":${port}"`,
    )
  }
  // Decided here, not by a URL library. Node's `new URL` happens to throw on
  // :65536, but this package also ships to browsers and React Native, and a
  // host runtime that quietly accepted an out-of-range port would make this
  // side accept a code the other side refuses -- with the suite still green,
  // because the suite runs on Node.
  if (port !== null && Number(port) > MAX_PORT) {
    throw bad(`port must be <= ${MAX_PORT}, got ":${port}"`)
  }
  assertCanonicalHost(authority, port, bad)
  // Dot segments are refused outright rather than folded: WHATWG folds them and
  // Go's url.Parse does not, so folding would derive two different origins from
  // one written URL. Percent-encoded spellings count as dot segments too.
  if (hasDotSegment(rawPath)) {
    throw bad(`URL path must not contain "." or ".." segments, got "${rawPath}"`)
  }
  // The path's spelling rule. Everything a parser would rewrite (`|`, `^`, a
  // backslash, raw non-ASCII) or reject (a lone `%`) is outside pchar, so this
  // one check replaces the old "must equal url.pathname" test -- which was not
  // a wire rule at all, since its judge was this runtime's parser.
  for (const segment of rawPath.split("/")) {
    if (!PCHAR_SEGMENT_RE.test(segment)) {
      throw bad(
        `URL path segment "${segment}" must contain only RFC 3986 pchar ` +
          "(unreserved / well-formed %XX / sub-delims / ':' / '@')",
      )
    }
    for (const [escape, digits] of segment.matchAll(PCT_ESCAPE_RE)) {
      if (/[a-f]/.test(digits ?? "")) {
        throw bad(
          `percent-encoded byte "${escape}" must use uppercase hex digits (encodeURIComponent already does)`,
        )
      }
    }
  }

  // No URL library is consulted, on purpose. A parser can only ever add
  // single-sided strictness here: anything it would reject that the rules above
  // accept is, by construction, an input this implementation refuses and the
  // other accepts -- which is the exact shape of every divergence this rule set
  // was written to close. So the accepted set is defined entirely by the rules
  // above, and link.test.ts sweeps a corpus of malformed URLs to assert that
  // every rejection still comes from one of them by name.
  const host = hostOf(authority, port).toLowerCase()
  const defaultPort = scheme === "https" ? "443" : "80"
  const origin =
    port === null || port === defaultPort ? `${scheme}://${host}` : `${scheme}://${host}:${port}`
  return { path: rawPath, host, origin }
}

/**
 * The authority's host must be written in the one canonical spelling.
 *
 * Not "must survive parsing unchanged" -- a WHATWG parser rewrites nine
 * different spellings into one host, and a parser that only lowercases keeps
 * them apart. `https://[2001:db8:0:0:0:0:0:1]/ipp/v1/link/<t>` against
 * `payload.endpoint = https://[2001:db8::1]` is then a match here and a
 * mismatch there: the same printed code pays in one wallet and is refused in
 * the other. So the spelling is judged here, on the string as written, before
 * any parser gets to rewrite it.
 */
function assertCanonicalHost(
  authority: string,
  port: string | null,
  bad: (detail: string) => Error,
): void {
  const host = hostOf(authority, port)
  if (host === "") throw bad("URL has no host")

  if (host.startsWith("[") || host.endsWith("]")) {
    if (!host.startsWith("[") || !host.endsWith("]")) {
      throw bad(`IPv6 host must be enclosed in brackets, got "${host}"`)
    }
    const inner = host.slice(1, -1)
    const canonical = canonicalIPv6(inner)
    if (canonical === null) {
      throw bad(
        "IPv6 host must be lowercase hexadecimal, with a dotted tail only in the " +
          `::ffff:a.b.c.d form, got "${inner}"`,
      )
    }
    if (inner !== canonical) {
      throw bad(
        `IPv6 host must be in RFC 5952 canonical form, got "${inner}" (canonical: "${canonical}")`,
      )
    }
    return
  }

  // Digits and dots only: an IPv4 literal attempt. It has exactly one legal
  // spelling -- four decimal octets, no leading zeros. Every other shape here
  // (three segments, a leading zero, one big integer) is something a WHATWG
  // parser silently turns INTO an address and another parser does not.
  if (DOTTED_NUMERIC_RE.test(host)) {
    const parts = host.split(".")
    const ok =
      parts.length === 4 &&
      parts.every((o) => /^(0|[1-9][0-9]{0,2})$/.test(o) && Number(o) <= 255)
    if (!ok) {
      throw bad(
        `IPv4 host must be four decimal octets with no leading zeros, got "${host}"`,
      )
    }
    return
  }

  const labels = host.split(".")
  for (const label of labels) {
    // Covers a trailing dot (`pay.example.com.`, `h.`), which is a second
    // spelling of the same host -- and the cross-check is string equality, so
    // two spellings of one endpoint means two unequal strings for one server.
    if (label === "") {
      throw bad(
        `host must not contain an empty label or a trailing dot, got "${host}"`,
      )
    }
    if (!LDH_LABEL_RE.test(label)) {
      throw bad(
        `host label "${label}" must contain only letters, digits and hyphens ` +
          "(use punycode for an IDN host)",
      )
    }
    if (label.length > MAX_LABEL_LENGTH) {
      throw bad(
        `host label must be at most ${MAX_LABEL_LENGTH} characters, got ${label.length}`,
      )
    }
    // RFC 1123's LDH label puts the hyphen strictly between other characters.
    // Stricter than a URL parser, deliberately: an LDH label is what the rule
    // says, and no host that resolves is spelled this way.
    if (label.startsWith("-") || label.endsWith("-")) {
      throw bad(`host label "${label}" must not start or end with a hyphen`)
    }
  }
  // A final label that reads as a number makes a URL parser treat the WHOLE
  // host as IPv4 -- `0x7f000001` becomes 127.0.0.1 -- while a parser that only
  // lowercases keeps a reg-name. The dotted-numeric branch above cannot catch
  // the hex spelling, since it contains letters.
  if (endsInANumber(labels)) {
    throw bad(
      `host must not end in a label that reads as a number ("${labels[labels.length - 1] ?? ""}"), ` +
        "which URL parsers treat as an IPv4 address",
    )
  }
}

/**
 * WHATWG URL Standard "ends in a number".
 *
 * Transcribed from the algorithm rather than paraphrased. A paraphrase
 * ("all digits, or 0x hex") happens to give the same answers -- the octal
 * branch below can only fire on a label starting with "0" that is not all
 * digits, and octal digits are a subset of decimal digits, so anything it
 * accepts step 4 already accepted -- but two implementations paraphrasing the
 * same rule independently is how the earlier divergences started. Citing the
 * algorithm removes the inference from both sides.
 */
function endsInANumber(labels: string[]): boolean {
  const parts = [...labels]
  if (parts[parts.length - 1] === "") {
    if (parts.length === 1) return false
    parts.pop()
  }
  const last = parts[parts.length - 1] ?? ""
  if (last !== "" && /^[0-9]+$/.test(last)) return true
  return parseIPv4Number(last) !== null
}

/** WHATWG URL Standard "IPv4 number parser"; null is its failure return. */
function parseIPv4Number(input: string): number | null {
  if (input === "") return null
  let rest = input
  let radix = 10
  if (rest.length >= 2 && (rest.startsWith("0x") || rest.startsWith("0X"))) {
    rest = rest.slice(2)
    radix = 16
  } else if (rest.length >= 2 && rest.startsWith("0")) {
    rest = rest.slice(1)
    radix = 8
  }
  if (rest === "") return 0
  const digits = radix === 16 ? /^[0-9A-Fa-f]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/
  if (!digits.test(rest)) return null
  return parseInt(rest, radix)
}

/**
 * The RFC 5952 canonical text of an IPv6 address, or null if `inner` is not a
 * lowercase IPv6 literal at all.
 *
 * The caller compares the written form against this, so this is only ever used
 * as a yardstick -- nothing in the resolver path or the returned endpoint is
 * built from it.
 */
function canonicalIPv6(inner: string): string | null {
  // Dots are legal only inside the one mixed form below; a dotted tail anywhere
  // else still parses here and is then refused by the comparison, with the
  // hex spelling named in the message.
  if (!/^[0-9a-f:.]+$/.test(inner)) return null
  const groups = parseIPv6(inner)
  if (groups === null) return null

  // RFC 5952 section 5: an IPv4-mapped address is written in mixed notation.
  // So `::ffff:7f00:1` is NOT the canonical spelling of 127.0.0.1 even though
  // that is what a WHATWG serializer prints -- the two sides have to agree on
  // one spelling, and the RFC is the one thing both can cite.
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const hi = groups[6] ?? 0
    const lo = groups[7] ?? 0
    return `::ffff:${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`
  }

  // Longest run of two or more zero groups, leftmost on a tie (RFC 5952 4.2).
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  for (let i = 0; i <= groups.length; i++) {
    if (i < groups.length && groups[i] === 0) {
      if (runStart === -1) runStart = i
    } else if (runStart !== -1) {
      const len = i - runStart
      if (len > bestLen) {
        bestLen = len
        bestStart = runStart
      }
      runStart = -1
    }
  }
  const hex = groups.map((g) => g.toString(16))
  if (bestLen < 2) return hex.join(":")
  const head = hex.slice(0, bestStart).join(":")
  const tail = hex.slice(bestStart + bestLen).join(":")
  return `${head}::${tail}`
}

/** The authority minus its ":port" suffix, as written. */
function hostOf(authority: string, port: string | null): string {
  return port === null ? authority : authority.slice(0, authority.length - port.length - 1)
}

/** The port as written, or null when the authority carries no ":" delimiter. */
function writtenPort(authority: string): string | null {
  let searchFrom = 0
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]")
    // An unterminated bracket has no port to find. Reporting no port sends the
    // whole authority to the bracket check in assertCanonicalHost, which is
    // what refuses it -- do not "fix" this by throwing here, or a host like
    // `[::1` would be diagnosed twice and `[::1]:8080` would lose its port.
    if (close === -1) return null
    searchFrom = close + 1
  }
  const idx = authority.indexOf(":", searchFrom)
  return idx === -1 ? null : authority.slice(idx + 1)
}

/** The link URL: shared wire rules, plus the `/ipp/v1/link/<token>` suffix. */
function parseLinkUrl(
  linkUrl: string,
  allowInsecure: boolean,
): { host: string; endpoint: string } {
  const wire = parseWireURL(linkUrl, allowInsecure, "IPP link")

  const pm = LINK_PATH_RE.exec(wire.path)
  if (pm === null) {
    throw new Error(
      `Invalid IPP link: path must end with "/ipp/v1/link/<22-char base64url token>", got "${wire.path}"`,
    )
  }
  const prefix = pm[1] ?? ""
  if (prefix !== "" && !PATH_PREFIX_RE.test(prefix)) {
    throw new Error(`Invalid IPP link: malformed endpoint path prefix "${prefix}"`)
  }
  return { host: wire.host, endpoint: `${wire.origin}${prefix}` }
}

/** `payload.endpoint`: shared wire rules, plus trailing-slash stripping. */
function normalizeEndpoint(endpoint: string | undefined, allowInsecure: boolean): string {
  if (typeof endpoint !== "string" || endpoint === "") {
    throw new Error("Invalid IPP link response: payload.endpoint is missing")
  }
  const wire = parseWireURL(endpoint, allowInsecure, "IPP link response payload.endpoint")
  // Strip trailing slashes BEFORE the empty-segment check, not after: that order
  // is what makes "https://h//" normalize to "https://h" instead of being
  // refused, and the order itself has to match the other implementation.
  const path = wire.path.replace(/\/+$/, "")
  if (path !== "" && !PATH_PREFIX_RE.test(path)) {
    throw new Error(
      `Invalid IPP link response payload.endpoint: malformed path "${path}"`,
    )
  }
  return `${wire.origin}${path}`
}

// --- Rule 4: loopback / private / link-local, judged on resolved addresses ---

type HostResolver = (hostname: string) => Promise<string[]>

let resolverPromise: Promise<HostResolver | null> | undefined

async function assertPublicTarget(host: string): Promise<void> {
  // The host arrives as written and lowercased. The spelling rules already
  // refused every obfuscated form of an address literal -- hex, octal, one big
  // integer, a three-segment dotted form -- so what reaches here is either the
  // single legal spelling of a literal or a name, with no parser in between.
  const literal = stripBrackets(host)
  const asIp = classifyAddress(literal)
  if (asIp === "blocked") {
    throw new Error(
      `Refusing to resolve IPP link: host "${host}" is a loopback / private / link-local address`,
    )
  }
  if (asIp === "public") return

  const lookup = await getResolver()
  if (lookup === null) {
    // Browsers expose no name resolution, so the resolved-address rule cannot
    // be enforced there -- a public name whose A record points at 127.0.0.1
    // still gets through. What does hold in a browser is that the response is
    // unreadable without permissive CORS, which internal services rarely send.
    // This name check only catches the honest local-dev cases.
    if (LOCAL_NAME_RE.test(host)) {
      throw new Error(
        `Refusing to resolve IPP link: host "${host}" names the local machine or local network`,
      )
    }
    return
  }

  let addresses: string[]
  try {
    addresses = await lookup(host)
  } catch (cause) {
    // Being offline is a transport failure, not a verdict about this host.
    // Reporting it as one would have the wallet tell the user "refused to
    // resolve", which reads as "this code is dangerous" rather than "no network".
    throw new ConnectionError(
      `cannot resolve host "${host}" (${cause instanceof Error ? cause.message : "lookup failed"})`,
      { cause },
    )
  }
  if (addresses.length === 0) {
    throw new ConnectionError(`host "${host}" resolved to no addresses`)
  }
  for (const address of addresses) {
    // Every answer must be public, not merely the first: a name that returns
    // one public and one internal address would otherwise be a coin flip
    // decided by whichever record the connect path happens to pick.
    if (classifyAddress(address) !== "public") {
      throw new Error(
        `Refusing to resolve IPP link: host "${host}" resolves to a non-public address (${address})`,
      )
    }
  }
}

function isNodeRuntime(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process
  return typeof proc?.versions?.node === "string"
}

async function getResolver(): Promise<HostResolver | null> {
  if (resolverPromise === undefined) resolverPromise = loadNodeResolver()
  return resolverPromise
}

/**
 * The Node resolver, or null when this is not Node.
 *
 * Null is reserved for "this runtime has no name resolution at all" -- the only
 * case allowed to fall back to the name heuristic. On Node the resolved-address
 * rule IS enforceable, so failing to load `node:dns` must throw rather than
 * return null: a stubbed specifier, a permission-restricted module, or an
 * Electron main-process bundle would otherwise silently downgrade the strictest
 * runtime to the weakest check, with nothing surfaced to the caller.
 */
async function loadNodeResolver(): Promise<HostResolver | null> {
  if (!isNodeRuntime()) return null
  let lookup: unknown
  try {
    // Assembled at runtime, and deliberately in a form no minifier folds back
    // into a literal: web bundlers that see a literal "node:dns" specifier try
    // to resolve a Node builtin and fail the build for the browser consumers
    // that are the majority of this package's users. The ignore comments cover
    // the bundlers that read them; the join covers the ones that do not.
    const specifier = ["node", "dns"].join(":")
    const dns = await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier)
    lookup = dns?.promises?.lookup ?? dns?.default?.promises?.lookup
  } catch (cause) {
    throw new Error(
      "Refusing to resolve IPP link: this is Node, where the private-network rule is " +
        `enforceable, but "node:dns" could not be loaded (${cause instanceof Error ? cause.message : "import failed"})`,
    )
  }
  if (typeof lookup !== "function") {
    throw new Error(
      'Refusing to resolve IPP link: this is Node, where the private-network rule is ' +
        'enforceable, but "node:dns" exposed no promises.lookup',
    )
  }
  const fn = lookup as (
    hostname: string,
    opts: { all: true; verbatim: true },
  ) => Promise<Array<{ address: string }>>
  return async (hostname: string) => {
    const records = await fn(hostname, { all: true, verbatim: true })
    return records.map((r) => r.address)
  }
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
}

function classifyAddress(value: string): "blocked" | "public" | "not-an-ip" {
  // fe80::1%en0 -- the zone id is routing information, not part of the address.
  const bare = stripBrackets(value).split("%")[0] ?? ""
  const v4 = parseIPv4(bare)
  if (v4 !== null) return isBlockedIPv4(v4) ? "blocked" : "public"
  const v6 = parseIPv6(bare.toLowerCase())
  if (v6 !== null) return isBlockedIPv6(v6) ? "blocked" : "public"
  return "not-an-ip"
}

function parseIPv4(value: string): [number, number, number, number] | null {
  const parts = value.split(".")
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out as [number, number, number, number]
}

function isBlockedIPv4([a, b, c]: [number, number, number, number]): boolean {
  if (a === 0) return true // 0.0.0.0/8 "this network"
  if (a === 10) return true // RFC 1918
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true // RFC 1918
  if (a === 192 && b === 168) return true // RFC 1918
  // 192.0.0.0/24 only -- the third octet is load-bearing. Widening this to
  // 192.0/16 also swallows 192.0.2.0/24 (TEST-NET-1), which is public here by
  // decision: the TEST-NET blocks do not route and host no internal service,
  // so they are not an SSRF target, and every address this list takes that the
  // Go implementation does not is one more code that pays in one wallet and
  // not the other.
  if (a === 192 && b === 0 && c === 0) return true // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true // RFC 6598 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true // RFC 2544 benchmarking
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

/**
 * Parse an IPv6 address into eight groups.
 *
 * Accepts the mixed `::ffff:127.0.0.1` notation, because this also parses
 * addresses handed back by the resolver, where that spelling is what Node
 * reports for a v4-mapped answer -- refusing it there would fail a legitimate
 * public target closed. The authority spelling rule is stricter and lives in
 * canonicalIPv6, which screens the mixed notation out before calling this.
 */
function parseIPv6(value: string): number[] | null {
  const lastColon = value.lastIndexOf(":")
  if (lastColon !== -1 && value.slice(lastColon + 1).includes(".")) {
    const embedded = parseIPv4(value.slice(lastColon + 1))
    if (embedded === null) return null
    const hi = ((embedded[0] << 8) | embedded[1]).toString(16)
    const lo = ((embedded[2] << 8) | embedded[3]).toString(16)
    return parseIPv6(`${value.slice(0, lastColon + 1)}${hi}:${lo}`)
  }
  if (!/^[0-9a-f:]+$/.test(value)) return null
  const dbl = value.indexOf("::")
  let head: string[]
  let tail: string[]
  if (dbl === -1) {
    head = value.split(":")
    tail = []
    if (head.length !== 8) return null
  } else {
    if (value.indexOf("::", dbl + 1) !== -1) return null
    const left = value.slice(0, dbl)
    const right = value.slice(dbl + 2)
    head = left === "" ? [] : left.split(":")
    tail = right === "" ? [] : right.split(":")
    if (head.length + tail.length > 7) return null
  }
  const groups: number[] = []
  for (const g of head) {
    const n = parseGroup(g)
    if (n === null) return null
    groups.push(n)
  }
  while (groups.length + tail.length < 8) groups.push(0)
  for (const g of tail) {
    const n = parseGroup(g)
    if (n === null) return null
    groups.push(n)
  }
  return groups.length === 8 ? groups : null
}

function parseGroup(g: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(g)) return null
  return parseInt(g, 16)
}

/** IPv4 carried inside `::ffff:0:0/96`, `::/96` (deprecated compat) or `64:ff9b::/96` (NAT64). */
function embeddedIPv4(g: number[]): [number, number, number, number] | null {
  const zeroLead = g.slice(0, 5).every((x) => x === 0)
  const isMapped = zeroLead && g[5] === 0xffff
  const isCompat = zeroLead && g[5] === 0
  const isNat64 = g[0] === 0x0064 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)
  if (!isMapped && !isCompat && !isNat64) return null
  const hi = g[6] ?? 0
  const lo = g[7] ?? 0
  return [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
}

function isBlockedIPv6(g: number[]): boolean {
  const g0 = g[0] ?? 0
  if (g.every((x) => x === 0)) return true // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true // ::1
  // An IPv4 address wearing an IPv6 costume: judge the address inside, never the
  // wrapper. All three wrappers below reach the same IPv4 host, and the same
  // code also judges AAAA records -- a hostile NAT64 answer is a real way to
  // hand a wallet an internal target that looks like a public IPv6 address.
  const embedded = embeddedIPv4(g)
  if (embedded !== null) return isBlockedIPv4(embedded)
  if ((g0 & 0xfe00) === 0xfc00) return true // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return true // ff00::/8 multicast
  return false
}

// --- Rule 7: response size cap ---------------------------------------------

async function readBodyBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = res.headers?.get?.("content-length")
  if (declared !== null && declared !== undefined && declared !== "") {
    const n = Number(declared)
    if (Number.isFinite(n) && n > maxBytes) {
      throw new Error(`IPP link response too large: ${n} bytes exceeds the ${maxBytes} byte cap`)
    }
  }

  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body
  if (!body || typeof body.getReader !== "function") {
    // No stream to meter: the bytes are already in memory, so the cap can only
    // be applied after. Read them as bytes, never via .text() -- that decoder
    // strips a leading BOM, and whether a BOM is present is a decision this
    // module has to make itself (see decodeLinkBody).
    const buffer = new Uint8Array(await res.arrayBuffer())
    if (buffer.byteLength > maxBytes) {
      throw new Error(
        `IPP link response too large: ${buffer.byteLength} bytes exceeds the ${maxBytes} byte cap`,
      )
    }
    return buffer
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > maxBytes) {
      // Stop pulling rather than buffering the rest: an unbounded body from a
      // hostile endpoint is the whole reason the cap exists.
      await reader.cancel()
      throw new Error(
        `IPP link response too large: exceeds the ${maxBytes} byte cap`,
      )
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.byteLength
  }
  return merged
}
