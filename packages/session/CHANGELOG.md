# @invisi-labs/session

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
