---
"@invisi-labs/core": minor
"@invisi-labs/ipp": minor
"@invisi-labs/payer": minor
"@invisi-labs/receiver": minor
---

feat(core): add domain-separated `deriveCreditNullifierKey` (`D_CREDIT_NKEY`) and `deriveChangeNullifierKey` (`D_CHANGE_NKEY`) key derivations (SPEC-028, SPEC-029).

feat(ipp): authorize response now delivers `creditNullifierKey` and carries `creditId`; payloads gain a `mode` field and no longer prefill `nonce`/`paymentCommitment`/`treeId`; propose and authorize responses now carry `treeId` (SPEC-028, SPEC-029).

feat(receiver): `createPaymentRequest` selects the payload `mode` and no longer prefills `nonce`/`paymentCommitment`; `creditNullifierKey` is derived on demand. Consumers that read the prefilled fields must now source them from the propose response or compute them via the selected mode.

feat(payer): consume the server-delivered credit key with two-step verification; add deterministic `deriveChange` for payBlind and source `treeId` from the propose response (SPEC-028, SPEC-029).
