# @invisi-labs/session

## Unreleased

- Recover confirmed tracked Provenance reproof through historical `submitSourceProof` after validating the mined locator, persisting the acknowledged replacement before polling and preserving the frozen transaction and tracking delivery mode. Custom `RecoveryService` adapters must expose `submitSourceProof`. Initial broadcast permits retain strict preflight evaluation.
- Support fee-free managed Credit pre-revocation in zero and undeployed token namespaces, including detached owner signatures and resume, while retaining Core pins and fee-bearing token validation.

## 1.3.3

- Batch authenticated public-history reads and coalesce Credit replay across empty ranges, preserving replay checkpoints until private transitions are committed and retaining live canonical fences.
- Share membership verification and captured preparation reads across refresh work. Add `inventoryOnly` scans that skip transaction prewarming and invalidate an older preparation snapshot; normal preparation continues to validate fresh captured state.
- Fence private observations before inventory commits: recheck history generation, chain identity, deployment and canonical block so a stale or reorged refresh cannot overwrite newer wallet state. Keep these checks live during Credit replay and unresolved retries.
- Migrate wallet inventory, receipts and managed Credit operations to uint128 grant identifiers and grant-status reconciliation. Validate UTC accounting periods at submission and recover definitive broadcaster refusals while requiring a newly prepared/authorized/proved statement before retry.
- Migration: update stored Credit records and custom storage/provider integrations to the current grant schema. An inventory-only refresh does not certify a transaction preparation snapshot.

## 1.3.2

- Align the fixed SDK release group with optional Payment Router support and independently authenticated Core and Provenance resource loading.

## 1.3.1

- Accept unified CreditDraw events in indexed Credit RPC responses, including post-debit state deliveries.
- Preserve canonical block, range, membership, duplicate and ciphertext checks; restore automatic IPP Credit reconciliation.
- Allow up to ten minutes for npm metadata and archive propagation while requiring matching archive integrity.

## 1.3.0

- Recover unified Note settlements and separate Credit state transitions without double-counting outputs.
- Validate the full initial-payment debit against owner balance and allowance before submission.

## 1.2.7

- Release with the SDK 1.2.7 package group, which includes the Barretenberg WASM SRS sizing fix.

## 1.2.6

- Update GitHub repository and release references to the `invisi-labs` organization.

## 1.2.5

- Read SQLite pages with one bounded query when the driver supports `all`, retaining the get-only fallback and detached result bytes.
- Reuse one detached inventory snapshot across a broadcaster quote's fee iterations and precompute record prefixes, preserving final operation-generation, invalidation, spent-state and reservation checks.

## 1.2.4

- Refresh gas benchmarks for the optimized Protocol contracts and validate authorization boundaries.

## 1.2.3

- Align the fixed package group with native-chain finality, offline transaction preparation, preparation-read reuse and shared portable Note interoperability checks.


## 1.2.2

- Require complete public receiving material for Wallet and bind App decryption to the explicit owner and available receiving keys.
- Detect public-history candidates locally instead of delegating detection to Protocol RPC.
- Persist signed broadcaster execution quotes and submit aggregate members through managed operations.
- Estimate prepared operation gas locally from version-independent benchmark shapes without proofs, ERC20 approval or RPC simulation.

## 1.2.1

- Share bounded public history across accounts; prioritize recent asset discovery, persist independent scan coverage, and expose recovery and spendability status.


## 1.2.0

- Align the six modules: pure primitives/protocol, independent prover/rpc, stateless sdk, managed session; retain React/Vue adapters.

- Persist atomic App-decrypted inventory and exact relay retry state with recoverable Source evidence.
- Keep the complete workspace release pinned to exact 1.2.0 package dependencies.


## 1.1.7

- Publish managed wallet sessions and explicit storage adapters as @invisi-labs/session.
- Export final Note outputs and change as IPN without changing transaction authorization.
- Provide managed wallet sessions, persistent operations, canonical updates, history and explicit storage adapters as a separate package.
