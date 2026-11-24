# @invisi-labs/ipp

## 1.3.5

- Release with exact 1.3.5 primitives and SDK dependencies for receiving-signature v1 and streamlined payment preparation; public IPP schemas are unchanged.

## 1.3.4

- Release with exact SDK 1.3.4 primitives and SDK dependencies for canonical Credit and Note identity handling. IPP receipt and credential schemas remain unchanged from 1.3.3.

## 1.3.3

- Replace `revocationShard` / `revocationSlot` with canonical positive uint128 decimal `grantId` in Credit receipts and optional credential proof metadata; update preparation output and strict receipt/credential validation.
- Migration: receipt producers and consumers must exchange the current `grantId` schema. Old shard/slot fields are rejected by the strict validator; use the matching Core deployment and fixed SDK 1.3.3 package group.

## 1.3.2

- Align the fixed SDK release group with optional Payment Router support and independently authenticated Core and Provenance resource loading.

## 1.3.1

- Accept unified CreditDraw events in indexed Credit RPC responses, including post-debit state deliveries.
- Preserve canonical block, range, membership, duplicate and ciphertext checks; restore automatic IPP Credit reconciliation.
- Allow up to ten minutes for npm metadata and archive propagation while requiring matching archive integrity.

## 1.3.0

- Add optional credit.initialPayment.amount and verified initial-payment receipt metadata, preserving frozen net terms.
- Remove the Invisi action field; select execution from method, mode and immutable request terms.

## 1.2.7

- Release with the SDK 1.2.7 package group, which includes the Barretenberg WASM SRS sizing fix.

## 1.2.6

- Update GitHub repository and release references to the `invisi-labs` organization.

## 1.2.5

- Add independent IPP types, HTTP client, merchant helpers and the optional Invisi transaction-preparation adapter.

