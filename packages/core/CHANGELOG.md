# @invisi-labs/core

## 2.2.0

### Patch Changes

- e410783: feat(ipp): AuthorizeRequest now carries `subscriptionId` and `creditNullifierKey`; voucher payload carries `receiving_address` instead of `identity_commitment` (breaking wire-format change for voucher consumers).

  fix(core): `poseidonHash` now rejects inputs outside the BN254 scalar field range instead of silently reducing them.

## 2.1.0

## 2.0.1

## 2.0.0

### Major Changes

- 1b73ab6: Breaking changes for the SPEC-144 wire format and credit authorize flow.

  - **ipp**: wire keys are now converted to `snake_case` at the codec boundary (SPEC-144). The over-the-wire JSON/msgpack field names changed; payloads produced by older clients are no longer compatible.
  - **core**: removed the deprecated `deriveClaimingKey` alias. Use the current key-derivation API.
  - **payer**: `payOpen` userOp `nonce` is now required (typed-data signing and calldata builder no longer fall back to a random nonce). Callers must supply the nonce explicitly.
  - **payer**: added credit authorize derive/verify helpers and new `AuthorizeRequest` fields; credit nonce is now taken from the authorize response instead of being generated locally.

  All `@invisi-labs/*` packages are version-linked and bump together to `2.0.0`.

## 1.0.2

## 1.0.1

### Patch Changes

- Export TREE_DEPTH protocol constant from @invisi-labs/core; @invisi-labs/tree now imports it instead of hardcoding.
