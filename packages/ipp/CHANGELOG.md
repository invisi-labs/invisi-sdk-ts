# @invisi-labs/ipp

## 2.6.1

### Patch Changes

- 3b53049: Move `node:dns` out of the main entry, and make `resolveIPPLink`'s transport
  rules a caller's choice instead of a second export.

  `link.ts` used to reach `node:dns` through a runtime-assembled specifier so that
  web bundlers would not try to resolve it. Metro rejects a non-literal `import()`
  at parse time and honours no ignore comment, so any React Native app that
  imported anything from this package — a type, `IPPClient`, anything — failed to
  bundle at all. The Node path now lives behind its own subpath export:

  ```ts
  import { resolveIPPLink } from "@invisi-labs/ipp";
  import { nodeHostResolver } from "@invisi-labs/ipp/node"; // Node only

  await resolveIPPLink(url, { hostResolver: nodeHostResolver });
  ```

  The main entry names no Node builtin, so every bundler can parse it. A caller
  that passes no `hostResolver` gets the host judged by how it is spelled, which
  is all a browser could ever do; passing one restores the strong check, where a
  public name whose A record points inside the network is refused.

  **Breaking:** `resolveIPPLinkUnsafe` is gone. It is now an option on the one
  function, which is how the rest of the ecosystem spells this:

  ```ts
  await resolveIPPLink(url); // https only (default)
  await resolveIPPLink(url, { allowInsecureTransport: true }); // also http + private targets
  ```

## 2.6.0

### Minor Changes

- f4837c9: Add `resolveIPPLink` / `resolveIPPLinkUnsafe` for the IPP short-link transport binding.

  A receive QR may now carry `https://<endpoint>/ipp/v1/link/<link_token>` instead of the
  self-contained `ipp1:` string, so a payer wallet needs a "scanned URL → IPPRequest" step.
  That step is where every payer-side safety rule lives, and it ships in the package so a
  third-party wallet gets the rules by installing it rather than re-deriving them: shape and
  `https` match before any request is issued, URL normalization (userinfo / query / fragment
  refused, host lowercased, default port dropped), private and loopback targets judged on the
  resolved address, anonymous request, refusal to follow redirects, size and time caps, and a
  cross-check that the endpoint inside the payload equals the one derived from the link.

  The response body contract is a bare JSON `IPPMessage` only — the compact `ipp1:` form is
  not accepted here, and unknown top-level envelope keys are refused, so the two SDK
  implementations cannot drift into accepting different things. On Node, failing to load
  `node:dns` throws rather than falling back to the weaker name check: the resolved-address
  rule is enforceable there, and downgrading it silently would give the caller no signal.

  The URL rules are strict about spelling, because two implementations that each normalize a
  sloppy URL their own way derive two different endpoints from one printed code -- so it pays
  in one wallet and is refused in the other. A port must be written canonically (`:0443` and
  an empty `:` are refused; `:443` is still dropped as the default), the authority must be
  ASCII (punycode for an IDN host -- UTS-46 silently _deletes_ U+200B and U+00AD, so
  `pay<ZWSP>.example.com` would otherwise be fetched as `pay.example.com`), and dot segments,
  a backslash authority, userinfo, query and fragment are all refused rather than rewritten.
  `payload.endpoint` is held to the same rules as the scanned link, since the two are compared
  to each other and a rule that guards only one of them guards neither.

  Host and path spelling are judged by explicit character sets rather than by "whatever this
  runtime's URL parser normalizes it to" -- the latter has no judge outside the runtime, so two
  implementations disagree by construction. A path segment must be RFC 3986 `pchar` with
  well-formed `%XX`; a host must be an LDH name, a four-octet dotted-quad IPv4 with no leading
  zeros, or a bracketed lowercase IPv6 in RFC 5952 canonical form. That refuses a batch of
  spellings a WHATWG parser silently rewrites into a _different_ host --
  `[2001:db8:0:0:0:0:0:1]`, `01.2.3.4`, `0177.0.0.1`, `0x7f000001`, `203.0.113`, `h%2e` -- each
  of which would otherwise make one wallet pay and another refuse the same printed code. Ports
  above 65535 are refused locally rather than left to the host runtime to throw, since this
  package also runs on browsers and React Native.

  Host spelling is tightened further: a name is an RFC 1123 LDH label per segment (1-63
  characters, no leading or trailing hyphen), a trailing dot is refused because it is a second
  spelling of one host and the cross-check is string equality, and a final label that reads as
  a number is refused per the WHATWG URL Standard "ends in a number" algorithm -- `0x7f000001`
  is a perfectly legal LDH label that a URL parser silently turns into `127.0.0.1`. An
  IPv4-mapped IPv6 address must be written in RFC 5952 section 5 mixed notation
  (`[::ffff:1.2.3.4]`, not `[::ffff:7f00:1]`), and no other prefix gets a dotted tail.

  The returned `endpoint` is built from the URL as written, with only the two normalizations
  the spelling rules leave open -- a reg-name's letter case, and a port equal to the scheme's
  default. It is no longer taken from the URL parser's rendering, which prints
  `[::ffff:1.2.3.4]` as `[::ffff:102:304]`: `endpoint` is the value a caller hands to
  `IPPClient` and that ends up in logs and on a confirmation screen, and each runtime renders
  that host differently. The request now goes to the URL as scanned for the same reason.

  No URL library is in the decision path at all. A parser can only add strictness on one side,
  and one-sided strictness is precisely what makes one wallet refuse a code another pays -- so
  the accepted set is defined entirely by the explicit rules above, and the returned `endpoint`
  is the host as written: an IPv4-mapped IPv6 host resolves to `https://[::ffff:1.2.3.4]`, not
  to a parser's rendering of it.

  Percent escapes in a path must use uppercase hex digits: `%2F` is accepted, `%2f` refused.
  Both spellings are well-formed pchar, so only an explicit rule sees the difference -- and
  without it, a link deriving `.../a%2Fb` against an endpoint written `.../a%2fb` is refused by
  a string comparison and accepted after RFC 3986 normalization. `encodeURIComponent` already
  emits uppercase.

  The response body is judged on bytes, not on decoded text. A leading UTF-8 BOM is refused
  outright, and only the four RFC 8259 whitespace bytes count as leading whitespace. Both
  matter because the layers above the bytes disagree: `TextDecoder` and `Response.text()`
  delete a leading BOM while other runtimes keep it, and `String.prototype.trim` and Go's
  `strings.TrimSpace` strip different sets. The body must also be well-formed
  UTF-8, checked on the bytes before anything decodes them: `TextDecoder` is non-fatal by
  default, so an invalid byte becomes U+FFFD and the text then parses cleanly -- and two
  different invalid bytes become the _same_ character, which would make two keys that differ on
  the wire arrive identical. Requiring well-formed input makes the decode lossless, so the rules
  below it are safe wherever they sit.

  Top-level keys are judged on their literal spelling: exactly one of the five, no `\` escape,
  no duplicates. `{"\u0076":1}` is the case that forces it -- `\u0076` is `v`, so parsing first
  puts the key inside the closed set while comparing written spellings puts it outside, and
  refusing the escape removes the choice. `https` must be spelled in lowercase rather than
  normalized.

  `resolveIPPLinkUnsafe` relaxes only `http` and private targets, for local deployments. It is
  a separate export rather than a flag so that a lint rule can ban it from release builds.

## 2.5.1

## 2.5.0

## 2.4.0

## 2.3.0

### Minor Changes

- 53ddc9c: feat(core): add domain-separated `deriveCreditNullifierKey` (`D_CREDIT_NKEY`) and `deriveChangeNullifierKey` (`D_CHANGE_NKEY`) key derivations (SPEC-028, SPEC-029).

  feat(ipp): authorize response now delivers `creditNullifierKey` and carries `creditId`; payloads gain a `mode` field and no longer prefill `nonce`/`paymentCommitment`/`treeId`; propose and authorize responses now carry `treeId` (SPEC-028, SPEC-029).

  feat(receiver): `createPaymentRequest` selects the payload `mode` and no longer prefills `nonce`/`paymentCommitment`; `creditNullifierKey` is derived on demand. Consumers that read the prefilled fields must now source them from the propose response or compute them via the selected mode.

  feat(payer): consume the server-delivered credit key with two-step verification; add deterministic `deriveChange` for payBlind and source `treeId` from the propose response (SPEC-028, SPEC-029).

## 2.2.0

### Minor Changes

- e410783: feat(ipp): AuthorizeRequest now carries `subscriptionId` and `creditNullifierKey`; voucher payload carries `receiving_address` instead of `identity_commitment` (breaking wire-format change for voucher consumers).

  fix(core): `poseidonHash` now rejects inputs outside the BN254 scalar field range instead of silently reducing them.

## 2.1.0

### Minor Changes

- 31c8ed9: IPPClient now handles all three IPP response channels with a typed error model, symmetric to the Go SDK (SPEC-156).

  - **Channel ① (HTTP 4xx/5xx):** parses the gateway's Stripe-style nested envelope `{error:{type,code,message,param,request_id,details}}` and throws a typed error — `InvalidRequestError` (400/412), `NotFoundError` (404), `ConflictError` (409), `RateLimitError` (429), `ApiError` (5xx + catch-all), all extending the base `IppError`. Fixes two bugs in `handleResponse`: it now checks `res.ok` BEFORE parsing the body (a non-JSON error body previously threw an opaque `SyntaxError`), and it no longer coerces the error object to a string (previously yielded `[object Object]`). A non-JSON / empty / shapeless error body, or a fetch rejection (network/timeout), now throws `ConnectionError` instead.
  - **Channel ② (HTTP 200 business rejection):** `{status:"rejected", reject_code, reason}` is no longer mistaken for an error — it resolves normally. Added `rejectCode?: RejectCode` to `AuthorizeResponse`, `ProposeResponse`, `CreditDrawResponse`, and `CreditReclaimResponse`.
  - **Channel ③ (relay async failure):** replaced the 9 bogus `RelayErrorCode` values (a dangling contract that never matched the server) with the real server codes (`relay_bad_calldata`, `relay_resolve_failed`, `relay_submit_failed`, `relay_sign_failed`, `relay_merchant_disabled`, `relay_unknown_mode`, `relay_missing_witness`, `relay_kms_sign_failed`), kept as an OPEN string type and read from `RelayStatusResponse.errorCode`. Removed the never-populated `errorCode` field from the synchronous `RelayResponse` / `RelayProveResponse`.
  - New `src/codes.ts` exports the reject + relay code catalogs (`REJECT_CODES`, `RELAY_ERROR_CODES`) and open-string types (`RejectCode`, `RelayErrorCode`), all lowercase and prefix-free to match the wire — new server codes flow through without an SDK change.

## 2.0.1

### Patch Changes

- 7feb88a: Fix IPPClient to convert wire fields between camelCase and snake_case at the HTTP boundary. It previously sent camelCase request bodies and read responses verbatim, so `/ipp/v1` requests were unparseable server-side and response fields came back `undefined`. Requests are now serialized as snake_case and responses decoded back to camelCase — the same conversion the QR/msgpack codec already applies; the error envelope is read as-is.

## 2.0.0

### Major Changes

- 1b73ab6: Breaking changes for the SPEC-144 wire format and credit authorize flow.

  - **ipp**: wire keys are now converted to `snake_case` at the codec boundary (SPEC-144). The over-the-wire JSON/msgpack field names changed; payloads produced by older clients are no longer compatible.
  - **core**: removed the deprecated `deriveClaimingKey` alias. Use the current key-derivation API.
  - **payer**: `payOpen` userOp `nonce` is now required (typed-data signing and calldata builder no longer fall back to a random nonce). Callers must supply the nonce explicitly.
  - **payer**: added credit authorize derive/verify helpers and new `AuthorizeRequest` fields; credit nonce is now taken from the authorize response instead of being generated locally.

  All `@invisi-labs/*` packages are version-linked and bump together to `2.0.0`.

## 1.0.2

### Patch Changes

- f510aa0: IPP versioned payload + address-transfer voucher (mode 3)

  - ipp: versioned `payload` envelope with a `type` discriminator (`request` | `voucher`); merge cancel into notify; add `IPPVoucher` / `IPPVoucherV1` types and `encodeIPPVoucher` / `decodeIPPVoucher` / `decodeIPPMessage`
  - payer: `buildVoucher` for mode 3 (payer-initiated address transfer); `buildPaymentFromRequest` updated for the nested payload
  - receiver: `verifyVoucher` + `voucherToWithdrawRequest`; `createPaymentRequest` now sets `type: "request"` and uses the nested payload

## 1.0.1
