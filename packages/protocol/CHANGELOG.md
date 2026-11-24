# @invisi-labs/protocol

## 1.3.5

- Reduce browser startup code using public ethers subpaths, lazy provider integration and compact published output; retain public ESM/CommonJS exports and source maps where configured.

- Release the fixed 1.3.5 package cohort with new v1 receiving material; keep deployed protocol ABI, gas model and authenticated circuit pins unchanged.

## 1.3.4

- Release with exact SDK 1.3.4 sibling dependencies, including canonical Credit identity handling in primitives. Protocol ABI and wire definitions remain unchanged from 1.3.3.

## 1.3.3

- Align Core and Factory ABIs with canonical Core `4940be2`: Core construction uses `(params, addressRegistry)` and Factory `deploy` / `computeInstanceAddress` use `(creationCode, salt, initialOwner, emergencyAdmin, addressRegistry)`. Remove the retired Core screening getter, setter, event and error; refresh ABI identity hashes.
- Replace Credit allocation and revocation bitmap interfaces with grant-status reads keyed by owner, token and uint128 `grantId`; use status 0 (unknown), 1 (active) and 2 (revoked). Update Credit creation, update, revoke, calldata, statement and gas shapes plus shared protocol vectors.
- Expose batched authenticated history and membership capabilities used by RPC and wallet synchronization, while preserving live canonical fences.
- Migration: custom chain readers and data providers must implement the new Credit status interfaces; update deployment calls and Credit wire fields together with the matching Core contracts and SDK package group.

## 1.3.2

- Align the fixed SDK release group with optional Payment Router support and independently authenticated Core and Provenance resource loading.

## 1.3.1

- Accept unified CreditDraw events in indexed Credit RPC responses, including post-debit state deliveries.
- Preserve canonical block, range, membership, duplicate and ciphertext checks; restore automatic IPP Credit reconciliation.
- Allow up to ten minutes for npm metadata and archive propagation while requiring matching archive integrity.

## 1.3.0

- Adopt unified Note settlement events and CreditDraw/CreditStateTransition, with canonical operation IDs and insertion-range validation.
- Refresh measured Note, Credit and optional initial-payment gas data; keep unsupported aggregate estimates explicit.

## 1.2.7

- Release with the SDK 1.2.7 package group, which includes the Barretenberg WASM SRS sizing fix.

## 1.2.6

- Update GitHub repository and release references to the `invisi-labs` organization.

## 1.2.5

- Synchronize contract ABIs and bindings with Invisi Core.


## 1.2.4

- Refresh gas benchmarks for the optimized Protocol contracts and validate authorization boundaries.

## 1.2.3

- Align the fixed package group with native-chain finality, offline transaction preparation, preparation-read reuse and shared portable Note interoperability checks.


## 1.2.2

- Remove delegated detection request fields from the Protocol RPC contract; detection remains local to the wallet.
- Estimate transaction gas from version-independent benchmark shapes and keep reference lookup internal.

## 1.2.1

- Align internal dependencies with the 1.2.1 workspace release.


## 1.2.0

- Align the six modules: pure primitives/protocol, independent prover/rpc, stateless sdk, managed session; retain React/Vue adapters.

- Ship the authenticated current Note, Credit and aggregate statements, deployment bindings and ABI.
- Keep the complete workspace release pinned to exact 1.2.0 package dependencies.


## 1.1.7

- Organize protocol capabilities by transaction and deployment responsibility.

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

- Remove the dedicated withdrawal builder in favor of unified transact. Registration accepts external signatures without a configured signer; the caller-only direct registration path remains.

- @invisi-labs/primitives@1.1.4
- @invisi-labs/prover@1.1.4
- @invisi-labs/rpc@1.1.4

## 1.1.3

### Patch Changes

- Support per-Credit single, UTC daily and UTC monthly spending limits, tracking actual usage even while a limit is disabled. Allow owner-authorized unexpired top-ups to update limits without resetting usage.

    Use authenticated Credit envelope version 5 and current Credit circuits, with chain-derived period validation and confirmed block timestamps for recovery. Previous Credit formats are rejected; compatible Protocol deployments and Protocol RPC v1.1.2 are required.

    Refresh real-verifier Credit gas references across creation, all four full/partial draw tiers, unchanged/changed-policy top-ups and cancellation. Synchronize 61 TypeScript/Go estimation vectors and document transaction gas-limit constraints.

- Updated dependencies
    - @invisi-labs/primitives@1.1.3
    - @invisi-labs/prover@1.1.3
    - @invisi-labs/rpc@1.1.3

## 1.1.2

### Patch Changes

- Support optional encrypted output memos of up to 256 bytes, with text and arbitrary byte payloads across funds notes, Credit lifecycle, storage, recovery and scoped disclosure.

    Use version 2 funds envelopes, version 4 Credit envelopes and length-prefixed aggregate deliveries. Keep the contract and RPC API at version 1, synchronize interoperability vectors, and update the examples. Deployments must support the new envelope formats.

- Updated dependencies
    - @invisi-labs/primitives@1.1.2
    - @invisi-labs/prover@1.1.2
    - @invisi-labs/rpc@1.1.2

## 1.1.1

### Patch Changes

- Use owner-authorized EIP-712 receiving-key registration with ERC-1271 support and direct owner calls. Registry operations become ready after signing and require no registration proof.

    Authenticate each Protocol's immutable registry binding, refresh current contract ABIs, and remove the registration circuit and obsolete private registration authorization APIs. Update registry examples and verify shared TS/Go signature vectors.

- Updated dependencies
    - @invisi-labs/primitives@1.1.1
    - @invisi-labs/prover@1.1.1
    - @invisi-labs/rpc@1.1.1

## 1.1.0

### Minor Changes

- Current multi-token Protocol and registry interfaces, transaction preparation, authorization statements, and authenticated witness layouts.
