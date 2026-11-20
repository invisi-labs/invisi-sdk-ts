# @invisi-labs/prover

## Unreleased

- Load Core and Provenance from independent authenticated catalogs with separate source options, a shared content-addressed cache, and explicit legacy compatibility. All Core circuits use one Core-only set. Publish both split catalogs before releasing these SDK defaults.

## 1.3.1

- Accept unified CreditDraw events in indexed Credit RPC responses, including post-debit state deliveries.
- Preserve canonical block, range, membership, duplicate and ciphertext checks; restore automatic IPP Credit reconciliation.
- Allow up to ten minutes for npm metadata and archive propagation while requiring matching archive integrity.

## 1.3.0

- Add the 18-input combined Credit initial-payment circuit using an independently pinned, lazily loaded resource set.
- Keep the existing circuit resource set and authenticated local directory, offline and cache behavior.

## 1.2.7

- Align BN254 SRS point requests with Barretenberg 6.0 batch sizes for WASM proving, verification, and Provenance.

## 1.2.6

- Update GitHub repository and release references to the `invisi-labs` organization.

## 1.2.5

- Load pinned, authenticated circuit resources on demand instead of including large circuit files in npm packages. Support local resource directories, offline circuit loading and the shared verified disk cache.
- Defer Noir runtime imports until witness generation; retain upstream WASM and official CRS distribution.


## 1.2.4

- Refresh gas benchmarks for the optimized Protocol contracts and validate authorization boundaries.

## 1.2.3

- Align the fixed package group with native-chain finality, offline transaction preparation, preparation-read reuse and shared portable Note interoperability checks.


## 1.2.2

- Align internal dependencies with the 1.2.2 workspace release.

## 1.2.1

- Align internal dependencies with the 1.2.1 workspace release.


## 1.2.0

- Align the six modules: pure primitives/protocol, independent prover/rpc, stateless sdk, managed session; retain React/Vue adapters.

- Ship the current authenticated native/recursive circuits and seven Source proof capacity tiers.
- Keep the complete workspace release pinned to exact 1.2.0 package dependencies.


## 1.1.7

- Organize proof adapters and authenticated resources into focused modules.

## 1.1.6

### Patch Changes

- Finalize context-bound NoteOutput creation, optional funds delivery, and EVM receiving-key resolution during preparation.
- Align broadcaster discovery, quoting and fee-funded transaction preparation with the current contracts.
- Refresh authenticated proof metadata, gas references, and wallet update batching.

## 1.1.5

### Patch Changes

- Align the fixed workspace release and internal dependency versions with 1.1.5.

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

- Authenticated BB 6.0.0 / Noir 1.0.0-rc.6 resources with native and WASM proving, independent verification, and aggregation.

## 1.0.2

### Patch Changes

- @invisi-labs/primitives@1.0.2

## 1.0.1

### Patch Changes

- Updated dependencies
    - @invisi-labs/primitives@1.0.1
