---
"@invisi-labs/core": major
"@invisi-labs/protocol": major
"@invisi-labs/sdk": major
---

Name the Credit owner explicitly: `ownerIdentityCommitment`, `ownerNoteSecret`, `ownerAddress`, and `owner` in Credit requests and events. Credit EIP-712 authorization schemas use `owner`; funding keeps its independent `payer` role. IPP authorization uses `ownerIdentityCommitment` / `owner_identity_commitment`. Circuit witness names are synchronized with authenticated artifacts. Commitment formulas, proof constraints and encrypted note bytes are unchanged.
