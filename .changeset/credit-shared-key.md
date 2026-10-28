---
"@invisi-labs/core": major
"@invisi-labs/sdk": major
---

Rename the shared Credit secret to `creditSharedKey`: use `generateCreditSharedKey()` and `CreditNote.creditSharedKey` in core, `credit_shared_key` / `credit_shared_keys` in private circuit witnesses, and `AuthorizeResponse.creditSharedKey` with the IPP wire field `credit_shared_key`. These names replace the previous Credit key names without compatibility aliases. Credit nullifiers, ordinary note nullifier names, encrypted note bytes, hash inputs, and cryptographic vectors are unchanged.
