---
"@invisi-labs/core": major
"@invisi-labs/protocol": major
"@invisi-labs/sdk": major
---

Expose only the current contract request shapes and canonical note APIs. Transact uses `sources` for zero, one or multiple trees. Note secrets and Credit shared-key hashes use explicit names. Applications supply note secrets and manage invoice associations. Shield request construction validates the accepted payment mode, and Credit verification hashes the actual shared key locally.

IPP uses current relay operations and explicit Credit spender/owner identities. Public Merkle requests reject private/obsolete fields, and the SDK omits unsupported historical Credit HTTP lifecycle helpers. Relay validates operation/circuit pairs and requires the explicit target instance for fully authorized calldata or explicit remote proving requests.

Authenticate aggregate inner verification-key commitments and validate user authorization digests, canonical padded statements, aggregate context and cross-member uniqueness before proof verification. Export aggregate circuit public-input construction separately from router business words. Proposal nonces use uniform Field rejection sampling.
