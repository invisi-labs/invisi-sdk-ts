---
"@invisi-labs/node": patch
---

proveWithWasm now passes `{ keccakZK: true }` to bb.js.

Without it bb.js picks its default proof flavour, whose byte layout no
`bb write_solidity_verifier` contract accepts — the length gate rejects it,
so every browser-generated proof reverted on-chain (surfacing as wallets
falling back to absurd gas limits after a failed estimation). CLI-generated
proofs were unaffected. Both the node wasm path and the browser entry share
this backend, so one change covers them.
