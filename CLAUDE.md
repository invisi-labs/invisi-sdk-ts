# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
pnpm install

# Build all packages (respects dependency order)
pnpm build

# Run all tests
pnpm test

# Type-check all packages
pnpm lint

# Clean all dist folders
pnpm clean

# Target a specific package
pnpm turbo run test --filter=@invisi-labs/core
pnpm turbo run build --filter=@invisi-labs/receiver

# Run tests inside a package directly
cd packages/core && pnpm test

# Release flow
pnpm changeset          # Create a changeset
pnpm version-packages   # Bump versions
pnpm release            # Build + publish
```

**Requirements:** pnpm 9.4.0+, Node >= 20.

## Architecture

This is a **Turbo + pnpm monorepo** for a privacy-preserving payment protocol SDK. All packages live under `packages/` and are published as `@invisi-labs/*`.

### Package Dependency Graph

```
@invisi-labs/core          ← Poseidon hash, commitments, nullifiers, key derivation
       ↓                  (uses @aztec/bb.js for Barretenberg cryptography)
@invisi-labs/ipp           ← IPP data format, encoding, CAIP-2, Interaction Protocol client (uses @msgpack/msgpack)
@invisi-labs/contracts     ← InvisiProtocol ABI + TypeScript types (no dependencies)
@invisi-labs/deployments   ← Chain deployment registry (no dependencies)
       ↓
@invisi-labs/payer         ← buildPayOpenCalldata, buildPayBlindCalldata, buildPaymentFromRequest, verifyPaymentCommitment
                          (uses viem + @invisi-labs/contracts + @invisi-labs/ipp)
@invisi-labs/receiver      ← generateInvoice, buildWithdrawCalldata, createPaymentRequest, computePaymentCommitmentForPropose
                          (uses @invisi-labs/core + @invisi-labs/contracts + @invisi-labs/deployments + @invisi-labs/ipp + viem)
       ↓
@invisi-labs/react         ← usePayOpen() hook, usePayBlind() hook (wraps @invisi-labs/payer)
@invisi-labs/vue           ← usePayOpen() composable, usePayBlind() composable (wraps @invisi-labs/payer)

@invisi-labs/node          ← Server-side ZK proof generation via nargo + bb CLI
                          (uses @invisi-labs/core, requires nargo & bb binaries)
```

### Key Concepts

- **Claiming key**: Derived per-invoice from a master key (`deriveClaimingKey(masterKey, invoiceId)` in `@invisi-labs/core`). Used to compute commitments and nullifiers.
- **Payment commitment**: `poseidonHash(identityCommitment, amount)` — stored on-chain when a payer deposits.
- **Nullifier**: `poseidonHash(claimingKey, amount)` — prevents double-spending during settlement.
- **Proof circuits**: `single_withdraw`, `batch_withdraw`, `shielded_payment` — generated server-side by `@invisi-labs/node` via two-step process: `nargo execute` (witness) then `bb prove` (proof).
- **IPPClient**: `new IPPClient(endpoint)` — HTTP client for IPP Interaction Protocol. Methods: `info`, `propose`, `authorize`, `status`, `notify`, `withdraw`, `creditDraw`, `creditReclaim`, `creditStatus`, `relay`, `relayStatus`.
- **createPaymentRequest**: Generates an `IPPRequest` from receiver credentials. Automatically computes `identityCommitment` and optionally pre-computes `nonce` + `paymentCommitment` (mode 1a).
- **buildPaymentFromRequest**: Constructs on-chain calldata from an `IPPRequest` + propose response. Verifies `paymentCommitment` before building.

### Contracts Sync

ABIs in `@invisi-labs/contracts` and deployment addresses in `@invisi-labs/deployments` are auto-synced from the `invisi-protocol` repo via the `protocol-sync` GitHub Actions workflow (triggered by a `protocol-release` repository dispatch event). Do not manually edit ABI files — they are generated.

### Build System

- **tsup** bundles each package to ESM + CJS with TypeScript declarations
- **turbo** orchestrates builds in dependency order (`^build` = dependencies must build first)
- Tests do not cache in turbo (`"cache": false`) — always run fresh
- Base TypeScript config in `tsconfig.base.json`: strict mode, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, ES2022 target

### Supported Chains

Mainnet: Ethereum (1), Optimism (10), Base (8453), Arbitrum (42161)
Testnet: Sepolia (11155111), Optimism Sepolia (11155420), Base Sepolia (84532), Arbitrum Sepolia (421614)
