---
"@invisi-labs/core": patch
---

Reduce masterKey into the BN254 field inside the key derivations.

`deriveNullifierKey` / `deriveCreditNullifierKey` / `deriveChangeNullifierKey`
treated their masterKey argument as a canonical field element, but a masterKey is
`keccak256(signature)` — a uniform 256-bit value that falls below the modulus only
~19% of the time. The other ~81% hit `poseidonHash`'s range check and threw
`RangeError: input[1] out of BN254 field range`, so privacy receive codes failed
for most wallets on any client that derives through this SDK.

Both reference implementations already reduce at this boundary — invisi-nexus
`pkg/kms.bytesToField` and invisi-sdk-rust `bytes_to_field` — so the derived keys
now match them bit for bit; new cross-language vectors lock that. The reduction is
applied only to the masterKey operand: invoiceId, creditId and paymentCommitment
are field elements by construction and stay under the range check.

Also exports `bytesToField` for callers that need the same byte-string → field
conversion elsewhere.
