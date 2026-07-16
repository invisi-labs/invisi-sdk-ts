# @invisi-labs/ipp

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
