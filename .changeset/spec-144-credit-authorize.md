---
"@invisi-labs/core": major
"@invisi-labs/ipp": major
"@invisi-labs/payer": major
---

Breaking changes for the SPEC-144 wire format and credit authorize flow.

- **ipp**: wire keys are now converted to `snake_case` at the codec boundary (SPEC-144). The over-the-wire JSON/msgpack field names changed; payloads produced by older clients are no longer compatible.
- **core**: removed the deprecated `deriveClaimingKey` alias. Use the current key-derivation API.
- **payer**: `payOpen` userOp `nonce` is now required (typed-data signing and calldata builder no longer fall back to a random nonce). Callers must supply the nonce explicitly.
- **payer**: added credit authorize derive/verify helpers and new `AuthorizeRequest` fields; credit nonce is now taken from the authorize response instead of being generated locally.

All `@invisi-labs/*` packages are version-linked and bump together to `2.0.0`.
