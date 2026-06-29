# @invisi-labs/receiver

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
