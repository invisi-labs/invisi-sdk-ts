# @invisi-labs/sdk

## 1.3.5

- Reduce browser startup code using public ethers subpaths, lazy provider integration and compact published output; retain public ESM/CommonJS exports and source maps where configured.

- Move invariant checks to initialization, select fresh nonces only during prepare, keep quote free of preparation and generate Source proofs in prove/ready. Submit retains live service validation, fee-lock binding, durable packet preservation and the final network fence without repeating proof or nonce reads. Reuse valid fee-lock tickets and fence cache invalidation against stale asynchronous failures.

## 1.3.4

- Accept equivalent hex casing for ordinary Note owners during explicit and managed preparation, authorization, and proving, including restored plans; retain strict nonzero 20-byte encoding and all commitment/context checks.

- Accept equivalent lowercase and checksummed Credit input identities for owner updates and spender draws, and group same-owner grants into one sorted payer receipt regardless of input address casing.

- Prepare fee-free public Credit revocation for zero or undeployed token namespaces. Keep Core deployment pins and authorization checks; fee-bearing revocation and repricing still require deployed ERC20 code.

## 1.3.3

- Generate and preserve positive uint128 Credit `grantId` values before proving; replace shard/slot fields in create, update, revoke, discovery, records, previews, signing statements and the ethers chain reader. Use matching Core grant-status reads and refreshed Credit gas baselines.
- Validate Credit UTC day/month bindings against the live submission head, including owner-authorized initial payments, so a proof cannot silently cross its authorized accounting period.
- Recognize only the structured broadcaster refusals `CREDIT_PERIOD_CHANGED`, `INSUFFICIENT_EXECUTION_SLACK` and `CREDIT_PERIOD_ENDING` as definitive non-submission. Recover the operation without marking it ambiguously sent; acknowledgement cannot authorize resubmitting the refused statement, and a fresh operation must be prepared, authorized and proved.
- Share verified membership reads during preparation and defer transaction prewarming after inventory refresh; continue validating reused snapshots against their captured context.
- Document canonical Router/7702 host preparation and generic Provenance output recognition, private Note spending, browser WASM and capability recovery examples. Keep host signing/submission explicit and Provenance capability metadata separate from Router semantic identity.
- Migration: replace Credit shard/slot inputs, saved state and custom reader hooks with `grantId` and grant status; upgrade all SDK packages alongside the matching Core deployment. The prior Credit wire schema cannot be used as current grant state.

## 1.3.2

- Support detached Router-funded payment preparation with no private inputs; preserve the host-managed proof lifecycle and exact funding amount. Release with the independent Core and Provenance resource catalogs.

## 1.3.1

- Accept unified CreditDraw events in indexed Credit RPC responses, including post-debit state deliveries.
- Preserve canonical block, range, membership, duplicate and ciphertext checks; restore automatic IPP Credit reconciliation.
- Allow up to ten minutes for npm metadata and archive propagation while requiring matching archive integrity.

## 1.3.0

- Support optional owner-authorized initial payment when creating Credit, with gross funding, merchant net Note and UTC-period validation.
- Align transaction discovery, calldata, previews and Gas estimates with the redeployed Core contracts.

## 1.2.7

- Release with the SDK 1.2.7 package group, which includes the Barretenberg WASM SRS sizing fix.

## 1.2.6

- Update GitHub repository and release references to the `invisi-labs` organization.

## 1.2.5

- Support independent IPP preparation through the separate IPP adapter without adding IPP to the main SDK dependency graph.


## 1.2.4

- Refresh gas benchmarks for the optimized Protocol contracts and validate authorization boundaries.

## 1.2.3

- Align the fixed package group with native-chain finality, offline transaction preparation, preparation-read reuse and shared portable Note interoperability checks.


## 1.2.2

- Require complete public receiving material for Wallet; keep identity-only authorization and decryption bound to explicit owner addresses.
- Follow signed broadcaster execution quotes and submit aggregate members with their bound execution context.
- Estimate prepared transaction gas locally from version-independent benchmark shapes without proofs, ERC20 approval or RPC simulation.

## 1.2.1

- Expose explicit native detection and decryption contracts with complete protocol context.


## 1.2.0

- Align the six modules: pure primitives/protocol, independent prover/rpc, stateless sdk, managed session; retain React/Vue adapters.

- Provide ready-statement Source proofs, recoverable public proof packets, local cache reuse and fee-frozen broadcaster submission.
- Keep the complete workspace release pinned to exact 1.2.0 package dependencies.


## 1.1.7

- Add canonical cross-language IPR payment requests and fixed-size IPN Note delivery.
- Add confirmed membership and owner spendability verification, plus final output and change export.
- Rename NoteOutputOptions to PaymentRequest; move managed sessions and storage to @invisi-labs/session.
- Separate managed wallet sessions and storage into `@invisi-labs/session`; retain stateless preparation in `@invisi-labs/sdk`.

## 1.1.6

### Patch Changes

- Finalize context-bound NoteOutput creation, optional funds delivery, and EVM receiving-key resolution during preparation.
- Align broadcaster discovery, quoting and fee-funded transaction preparation with the current contracts.
- Refresh authenticated proof metadata, gas references, and wallet update batching.

## 1.1.5

### Patch Changes

- Expose getTransactionUpdates through the ethers-integrated ProtocolRpcClient and export ProtocolTransactionUpdates and ProtocolCreditTransition types.

## 1.1.4

### Patch Changes

- Remove detached local-signing shortcuts and implicit private-wallet authorization; use portable requests and externally supplied signatures. Keep explicit local signing in WalletSession. Replace workspace examples with flat, configurable English walkthroughs and local account setup.

- Add managed wallet sessions with encrypted persistence, incoming and outgoing history, recovery, and explicit signer capabilities. Support external authorization requests, public wallets, unified transfer preparation, registry discovery, multi-owner credit draws, and raw application payloads with explicit decoding. Select single or aggregate execution when proving.
    - @invisi-labs/primitives@1.1.4
    - @invisi-labs/protocol@1.1.4
    - @invisi-labs/prover@1.1.4
    - @invisi-labs/rpc@1.1.4

## 1.1.3

### Patch Changes

- Support per-Credit single, UTC daily and UTC monthly spending limits, tracking actual usage even while a limit is disabled. Allow owner-authorized unexpired top-ups to update limits without resetting usage.

    Use authenticated Credit envelope version 5 and current Credit circuits, with chain-derived period validation and confirmed block timestamps for recovery. Previous Credit formats are rejected; compatible Protocol deployments and Protocol RPC v1.1.2 are required.

    Refresh real-verifier Credit gas references across creation, all four full/partial draw tiers, unchanged/changed-policy top-ups and cancellation. Synchronize 61 TypeScript/Go estimation vectors and document transaction gas-limit constraints.

- Updated dependencies
    - @invisi-labs/primitives@1.1.3
    - @invisi-labs/protocol@1.1.3
    - @invisi-labs/prover@1.1.3
    - @invisi-labs/rpc@1.1.3

## 1.1.2

### Patch Changes

- Support optional encrypted output memos of up to 256 bytes, with text and arbitrary byte payloads across funds notes, Credit lifecycle, storage, recovery and scoped disclosure.

    Use version 2 funds envelopes, version 4 Credit envelopes and length-prefixed aggregate deliveries. Keep the contract and RPC API at version 1, synchronize interoperability vectors, and update the examples. Deployments must support the new envelope formats.

- Updated dependencies
    - @invisi-labs/primitives@1.1.2
    - @invisi-labs/protocol@1.1.2
    - @invisi-labs/prover@1.1.2
    - @invisi-labs/rpc@1.1.2

## 1.1.1

### Patch Changes

- Use owner-authorized EIP-712 receiving-key registration with ERC-1271 support and direct owner calls. Registry operations become ready after signing and require no registration proof.

    Authenticate each Protocol's immutable registry binding, refresh current contract ABIs, and remove the registration circuit and obsolete private registration authorization APIs. Update registry examples and verify shared TS/Go signature vectors.

- Updated dependencies
    - @invisi-labs/primitives@1.1.1
    - @invisi-labs/protocol@1.1.1
    - @invisi-labs/prover@1.1.1
    - @invisi-labs/rpc@1.1.1

## 1.1.0

### Minor Changes

- Explicit transaction preparation and managed wallet sessions, local note inventory, authorization, proving, and ethers transaction integration.
