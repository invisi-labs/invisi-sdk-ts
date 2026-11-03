# @invisi-labs/sdk

## 1.1.5

### Patch Changes

- Expose getTransactionUpdates through the ethers-integrated ProtocolRpcClient and export ProtocolTransactionUpdates and ProtocolCreditTransition types.

## 1.1.4

### Patch Changes

- Remove detached local-signing shortcuts and implicit private-wallet authorization; use portable requests and externally supplied signatures. Keep explicit local signing in WalletSession. Replace workspace examples with flat, configurable English walkthroughs and local account setup.

- Add managed wallet sessions with encrypted persistence, incoming and outgoing history, recovery, and explicit signer capabilities. Support external authorization requests, public wallets, unified transfer preparation, registry discovery, multi-owner credit draws, and raw application payloads with explicit decoding. Select single or aggregate execution when proving.
    - @invisi-labs/core@1.1.4
    - @invisi-labs/protocol@1.1.4
    - @invisi-labs/prover@1.1.4
    - @invisi-labs/rpc@1.1.4

## 1.1.3

### Patch Changes

- Support per-Credit single, UTC daily and UTC monthly spending limits, tracking actual usage even while a limit is disabled. Allow owner-authorized unexpired top-ups to update limits without resetting usage.

    Use authenticated Credit envelope version 5 and current Credit circuits, with chain-derived period validation and confirmed block timestamps for recovery. Previous Credit formats are rejected; compatible Protocol deployments and Protocol RPC v1.1.2 are required.

    Refresh real-verifier Credit gas references across creation, all four full/partial draw tiers, unchanged/changed-policy top-ups and cancellation. Synchronize 61 TypeScript/Go estimation vectors and document transaction gas-limit constraints.

- Updated dependencies
    - @invisi-labs/core@1.1.3
    - @invisi-labs/protocol@1.1.3
    - @invisi-labs/prover@1.1.3
    - @invisi-labs/rpc@1.1.3

## 1.1.2

### Patch Changes

- Support optional encrypted output memos of up to 256 bytes, with text and arbitrary byte payloads across funds notes, Credit lifecycle, storage, recovery and scoped disclosure.

    Use version 2 funds envelopes, version 4 Credit envelopes and length-prefixed aggregate deliveries. Keep the contract and RPC API at version 1, synchronize interoperability vectors, and update the examples. Deployments must support the new envelope formats.

- Updated dependencies
    - @invisi-labs/core@1.1.2
    - @invisi-labs/protocol@1.1.2
    - @invisi-labs/prover@1.1.2
    - @invisi-labs/rpc@1.1.2

## 1.1.1

### Patch Changes

- Use owner-authorized EIP-712 receiving-key registration with ERC-1271 support and direct owner calls. Registry operations become ready after signing and require no registration proof.

    Authenticate each Protocol's immutable registry binding, refresh current contract ABIs, and remove the registration circuit and obsolete private registration authorization APIs. Update registry examples and verify shared TS/Go signature vectors.

- Updated dependencies
    - @invisi-labs/core@1.1.1
    - @invisi-labs/protocol@1.1.1
    - @invisi-labs/prover@1.1.1
    - @invisi-labs/rpc@1.1.1

## 1.1.0

### Minor Changes

- Explicit transaction preparation and managed wallet sessions, local note inventory, authorization, proving, and ethers transaction integration.
