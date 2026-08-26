---
"@invisi-labs/ipp": minor
---

Add `resolveIPPLink` / `resolveIPPLinkUnsafe` for the IPP short-link transport binding.

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
ASCII (punycode for an IDN host -- UTS-46 silently *deletes* U+200B and U+00AD, so
`pay<ZWSP>.example.com` would otherwise be fetched as `pay.example.com`), and dot segments,
a backslash authority, userinfo, query and fragment are all refused rather than rewritten.
`payload.endpoint` is held to the same rules as the scanned link, since the two are compared
to each other and a rule that guards only one of them guards neither.

Host and path spelling are judged by explicit character sets rather than by "whatever this
runtime's URL parser normalizes it to" -- the latter has no judge outside the runtime, so two
implementations disagree by construction. A path segment must be RFC 3986 `pchar` with
well-formed `%XX`; a host must be an LDH name, a four-octet dotted-quad IPv4 with no leading
zeros, or a bracketed lowercase IPv6 in RFC 5952 canonical form. That refuses a batch of
spellings a WHATWG parser silently rewrites into a *different* host --
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
different invalid bytes become the *same* character, which would make two keys that differ on
the wire arrive identical. Requiring well-formed input makes the decode lossless, so the rules
below it are safe wherever they sit.

Top-level keys are judged on their literal spelling: exactly one of the five, no `\` escape,
no duplicates. `{"\u0076":1}` is the case that forces it -- `\u0076` is `v`, so parsing first
puts the key inside the closed set while comparing written spellings puts it outside, and
refusing the escape removes the choice. `https` must be spelled in lowercase rather than
normalized.

`resolveIPPLinkUnsafe` relaxes only `http` and private targets, for local deployments. It is
a separate export rather than a flag so that a lint rule can ban it from release builds.
