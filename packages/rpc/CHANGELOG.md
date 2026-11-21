# @invisi-labs/rpc

## Unreleased

- Read consecutive historical headers through `invisi_getBlockHeaders` in ranges of up to 256, checking full-header hashes, deployment pins, range anchors and parent continuity, including all fork fields through `slotNumber` and rejecting missing fork-field gaps. Public history uses this path automatically.
- Fall back to live batched reads only when the server explicitly reports missing method or missing stored history; malformed responses fail closed. Missing later chunks discard partial history and restart the entire live batch, including through independent CommonJS package entrypoints. Nonconsecutive heights and heights above JavaScript's safe integer range retain exact live hexadecimal reads. Single-block, finality and canonical reorg checks stay live.

## 1.3.2

- Align the fixed SDK release group with optional Payment Router support and independently authenticated Core and Provenance resource loading.

## 1.3.1

- Accept unified CreditDraw events in indexed Credit RPC responses, including post-debit state deliveries.
- Preserve canonical block, range, membership, duplicate and ciphertext checks; restore automatic IPP Credit reconciliation.
- Allow up to ten minutes for npm metadata and archive propagation while requiring matching archive integrity.

## 1.3.0

- Recognize NoteOutputs, CreditDraw and CreditStateTransition in authenticated Note and Credit discovery.
- Align current contract bindings while preserving explicitly supported legacy creation codecs.

## 1.2.7

- Release with the SDK 1.2.7 package group, which includes the Barretenberg WASM SRS sizing fix.

## 1.2.6

- Update GitHub repository and release references to the `invisi-labs` organization.

## 1.2.5

- Align the fixed release cohort with current Invisi Core interfaces and independent prover resources.


## 1.2.4

- Refresh gas benchmarks for the optimized Protocol contracts and validate authorization boundaries.

## 1.2.3

- Align the fixed package group with native-chain finality, offline transaction preparation, preparation-read reuse and shared portable Note interoperability checks.


## 1.2.2

- Remove delegated detection options and requests; query public candidates for local wallet detection.
- Add signed broadcaster execution quotes, aggregate-member submission, and execution status handling.

## 1.2.1

- Align internal dependencies with the 1.2.1 workspace release.


## 1.2.0

- Align the six modules: pure primitives/protocol, independent prover/rpc, stateless sdk, managed session; retain React/Vue adapters.

- Provide the current separate Note/Credit query surfaces and canonical broadcaster discovery.
- Keep the complete workspace release pinned to exact 1.2.0 package dependencies.


## 1.1.7

- Add commitment-based Note lookup with independently verified Merkle membership and canonical chain anchors.

## 1.1.6

### Patch Changes

- Finalize context-bound NoteOutput creation, optional funds delivery, and EVM receiving-key resolution during preparation.
- Align broadcaster discovery, quoting and fee-funded transaction preparation with the current contracts.
- Refresh authenticated proof metadata, gas references, and wallet update batching.

## 1.1.5

### Patch Changes

- Add getTransactionUpdates with typed availability states, canonical transaction/output checks, Credit transitions and stale-checkpoint handling. Requires Protocol RPC 1.1.4 or newer.

## 1.1.4

### Patch Changes

- @invisi-labs/primitives@1.1.4

## 1.1.3

### Patch Changes

- Support per-Credit single, UTC daily and UTC monthly spending limits, tracking actual usage even while a limit is disabled. Allow owner-authorized unexpired top-ups to update limits without resetting usage.

    Use authenticated Credit envelope version 5 and current Credit circuits, with chain-derived period validation and confirmed block timestamps for recovery. Previous Credit formats are rejected; compatible Protocol deployments and Protocol RPC v1.1.2 are required.

    Refresh real-verifier Credit gas references across creation, all four full/partial draw tiers, unchanged/changed-policy top-ups and cancellation. Synchronize 61 TypeScript/Go estimation vectors and document transaction gas-limit constraints.

- Updated dependencies
    - @invisi-labs/primitives@1.1.3

## 1.1.2

### Patch Changes

- Support optional encrypted output memos of up to 256 bytes, with text and arbitrary byte payloads across funds notes, Credit lifecycle, storage, recovery and scoped disclosure.

    Use version 2 funds envelopes, version 4 Credit envelopes and length-prefixed aggregate deliveries. Keep the contract and RPC API at version 1, synchronize interoperability vectors, and update the examples. Deployments must support the new envelope formats.

- Updated dependencies
    - @invisi-labs/primitives@1.1.2

## 1.1.1

### Patch Changes

- Use owner-authorized EIP-712 receiving-key registration with ERC-1271 support and direct owner calls. Registry operations become ready after signing and require no registration proof.

    Authenticate each Protocol's immutable registry binding, refresh current contract ABIs, and remove the registration circuit and obsolete private registration authorization APIs. Update registry examples and verify shared TS/Go signature vectors.

- Updated dependencies
    - @invisi-labs/primitives@1.1.1

## 1.1.0

### Minor Changes

- Protocol RPC discovery, deployment metadata, address resolution, public history, candidates, and membership queries.
