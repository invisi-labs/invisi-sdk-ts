# @invisi-labs/react

## 1.3.5

- Release with exact SDK/session 1.3.5 dependencies for receiving-signature v1 and atomic submit recovery; adapter APIs are unchanged.

## 1.3.4

- Release with exact SDK/session 1.3.4 dependencies, inheriting address casing compatibility, historical source-proof recovery and validation before operation lease takeover. React adapter implementation remains unchanged; custom RecoveryService adapters must add submitSourceProof as described by session.

## 1.3.3

- Release with the fixed SDK 1.3.3 package group and exact sibling dependencies. The React adapter implementation is unchanged; consumers inherit the updated session refresh, submission recovery and Credit grant schema from SDK/session dependencies. Migrate Credit state and custom integrations as described in those package entries.

## 1.3.2

- Align the fixed SDK release group with optional Payment Router support and independently authenticated Core and Provenance resource loading.

## 1.3.1

- Accept unified CreditDraw events in indexed Credit RPC responses, including post-debit state deliveries.
- Preserve canonical block, range, membership, duplicate and ciphertext checks; restore automatic IPP Credit reconciliation.
- Allow up to ten minutes for npm metadata and archive propagation while requiring matching archive integrity.

## 1.3.0

- Align the React adapter with the SDK 1.3.0 cohort and updated managed Note/Credit flows.

## 1.2.7

- Release with the SDK 1.2.7 package group, which includes the Barretenberg WASM SRS sizing fix.

## 1.2.6

- Update GitHub repository and release references to the `invisi-labs` organization.

## 1.2.5

- Align exact sibling dependencies with the 1.2.5 SDK cohort.


## 1.2.4

- Refresh gas benchmarks for the optimized Protocol contracts and validate authorization boundaries.

## 1.2.3

- Align the fixed package group with native-chain finality, offline transaction preparation, preparation-read reuse and shared portable Note interoperability checks.


## 1.2.2

- Align managed wallet bindings and internal dependencies with the 1.2.2 workspace release.

## 1.2.1

- Align internal dependencies with the 1.2.1 workspace release.


## 1.2.0

- Align the six modules: pure primitives/protocol, independent prover/rpc, stateless sdk, managed session; retain React/Vue adapters.

- Keep React lifecycle bindings aligned with the 1.2.0 SDK and Session APIs.
- Keep the complete workspace release pinned to exact 1.2.0 package dependencies.


## 1.1.7

- Use the independent @invisi-labs/session package for managed wallet integration.
- Separate managed wallet sessions and storage into `@invisi-labs/session`; retain stateless preparation in `@invisi-labs/sdk`.

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

- Updated dependencies
    - @invisi-labs/sdk@1.1.4

## 1.1.3

### Patch Changes

- Support per-Credit single, UTC daily and UTC monthly spending limits, tracking actual usage even while a limit is disabled. Allow owner-authorized unexpired top-ups to update limits without resetting usage.

    Use authenticated Credit envelope version 5 and current Credit circuits, with chain-derived period validation and confirmed block timestamps for recovery. Previous Credit formats are rejected; compatible Protocol deployments and Protocol RPC v1.1.2 are required.

    Refresh real-verifier Credit gas references across creation, all four full/partial draw tiers, unchanged/changed-policy top-ups and cancellation. Synchronize 61 TypeScript/Go estimation vectors and document transaction gas-limit constraints.

- Updated dependencies
    - @invisi-labs/sdk@1.1.3

## 1.1.2

### Patch Changes

- Support optional encrypted output memos of up to 256 bytes, with text and arbitrary byte payloads across funds notes, Credit lifecycle, storage, recovery and scoped disclosure.

    Use version 2 funds envelopes, version 4 Credit envelopes and length-prefixed aggregate deliveries. Keep the contract and RPC API at version 1, synchronize interoperability vectors, and update the examples. Deployments must support the new envelope formats.

- Updated dependencies
    - @invisi-labs/sdk@1.1.2

## 1.1.1

### Patch Changes

- Use owner-authorized EIP-712 receiving-key registration with ERC-1271 support and direct owner calls. Registry operations become ready after signing and require no registration proof.

    Authenticate each Protocol's immutable registry binding, refresh current contract ABIs, and remove the registration circuit and obsolete private registration authorization APIs. Update registry examples and verify shared TS/Go signature vectors.

- Updated dependencies
    - @invisi-labs/sdk@1.1.1

## 1.1.0

### Minor Changes

- React operation hooks for the current wallet and transaction APIs.

## 1.0.2

### Patch Changes

- Updated dependencies [f510aa0]
    - @invisi-labs/payer@1.0.2

## 1.0.1

### Patch Changes

- @invisi-labs/payer@1.0.1
