# @invisi-labs/payer

## 2.5.1

### Patch Changes

- @invisi-labs/core@2.5.1
- @invisi-labs/contracts@2.5.1
- @invisi-labs/deployments@2.5.1
- @invisi-labs/ipp@2.5.1

## 2.5.0

### Patch Changes

- Updated dependencies [b4f7f5b]
- Updated dependencies [86a398b]
  - @invisi-labs/core@2.5.0
  - @invisi-labs/contracts@2.5.0
  - @invisi-labs/deployments@2.5.0
  - @invisi-labs/ipp@2.5.0

## 2.4.0

### Minor Changes

- 4e54020: Add EIP-2612 permit typed-data builder and payBlindWithSig/payOpenWithSig
  calldata encoders for single-transaction (approve-less) privacy payments.

### Patch Changes

- @invisi-labs/core@2.4.0
- @invisi-labs/contracts@2.4.0
- @invisi-labs/deployments@2.4.0
- @invisi-labs/ipp@2.4.0

## 2.3.0

### Minor Changes

- 53ddc9c: feat(core): add domain-separated `deriveCreditNullifierKey` (`D_CREDIT_NKEY`) and `deriveChangeNullifierKey` (`D_CHANGE_NKEY`) key derivations (SPEC-028, SPEC-029).

  feat(ipp): authorize response now delivers `creditNullifierKey` and carries `creditId`; payloads gain a `mode` field and no longer prefill `nonce`/`paymentCommitment`/`treeId`; propose and authorize responses now carry `treeId` (SPEC-028, SPEC-029).

  feat(receiver): `createPaymentRequest` selects the payload `mode` and no longer prefills `nonce`/`paymentCommitment`; `creditNullifierKey` is derived on demand. Consumers that read the prefilled fields must now source them from the propose response or compute them via the selected mode.

  feat(payer): consume the server-delivered credit key with two-step verification; add deterministic `deriveChange` for payBlind and source `treeId` from the propose response (SPEC-028, SPEC-029).

### Patch Changes

- Updated dependencies [53ddc9c]
  - @invisi-labs/core@2.3.0
  - @invisi-labs/ipp@2.3.0
  - @invisi-labs/contracts@2.3.0
  - @invisi-labs/deployments@2.3.0

## 2.2.0

### Patch Changes

- Updated dependencies [e410783]
  - @invisi-labs/ipp@2.2.0
  - @invisi-labs/core@2.2.0
  - @invisi-labs/contracts@2.2.0
  - @invisi-labs/deployments@2.2.0

## 2.1.0

### Patch Changes

- Updated dependencies [31c8ed9]
  - @invisi-labs/ipp@2.1.0
  - @invisi-labs/core@2.1.0
  - @invisi-labs/contracts@2.1.0
  - @invisi-labs/deployments@2.1.0

## 2.0.1

### Patch Changes

- Updated dependencies [7feb88a]
  - @invisi-labs/ipp@2.0.1
  - @invisi-labs/core@2.0.1
  - @invisi-labs/contracts@2.0.1
  - @invisi-labs/deployments@2.0.1

## 2.0.0

### Major Changes

- 1b73ab6: Breaking changes for the SPEC-144 wire format and credit authorize flow.

  - **ipp**: wire keys are now converted to `snake_case` at the codec boundary (SPEC-144). The over-the-wire JSON/msgpack field names changed; payloads produced by older clients are no longer compatible.
  - **core**: removed the deprecated `deriveClaimingKey` alias. Use the current key-derivation API.
  - **payer**: `payOpen` userOp `nonce` is now required (typed-data signing and calldata builder no longer fall back to a random nonce). Callers must supply the nonce explicitly.
  - **payer**: added credit authorize derive/verify helpers and new `AuthorizeRequest` fields; credit nonce is now taken from the authorize response instead of being generated locally.

  All `@invisi-labs/*` packages are version-linked and bump together to `2.0.0`.

### Patch Changes

- Updated dependencies [1b73ab6]
  - @invisi-labs/core@2.0.0
  - @invisi-labs/ipp@2.0.0
  - @invisi-labs/contracts@2.0.0
  - @invisi-labs/deployments@2.0.0

## 1.0.2

### Patch Changes

- f510aa0: IPP versioned payload + address-transfer voucher (mode 3)

  - ipp: versioned `payload` envelope with a `type` discriminator (`request` | `voucher`); merge cancel into notify; add `IPPVoucher` / `IPPVoucherV1` types and `encodeIPPVoucher` / `decodeIPPVoucher` / `decodeIPPMessage`
  - payer: `buildVoucher` for mode 3 (payer-initiated address transfer); `buildPaymentFromRequest` updated for the nested payload
  - receiver: `verifyVoucher` + `voucherToWithdrawRequest`; `createPaymentRequest` now sets `type: "request"` and uses the nested payload

- Updated dependencies [f510aa0]
  - @invisi-labs/ipp@1.0.2
  - @invisi-labs/core@1.0.2
  - @invisi-labs/contracts@1.0.2
  - @invisi-labs/deployments@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies
  - @invisi-labs/core@1.0.1
  - @invisi-labs/contracts@1.0.1
  - @invisi-labs/deployments@1.0.1
  - @invisi-labs/ipp@1.0.1
