---
"@invisi-labs/ipp": minor
"@invisi-labs/core": patch
---

feat(ipp): AuthorizeRequest now carries `subscriptionId` and `creditNullifierKey`; voucher payload carries `receiving_address` instead of `identity_commitment` (breaking wire-format change for voucher consumers).

fix(core): `poseidonHash` now rejects inputs outside the BN254 scalar field range instead of silently reducing them.
