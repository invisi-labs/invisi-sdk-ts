# Invisi SDK Examples

This directory contains 13 standalone examples demonstrating typical usage of each Invisi SDK package.

## Prerequisites

- Node.js 20+
- pnpm 9+
- Base Sepolia testnet ETH (for gas)
- Base Sepolia USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`)
- Copy `shared/.env.example` to `shared/.env` (or `.env` in each example directory) and fill in the configuration

## Example Index

| No. | Name | Packages Used | Description |
|-----|------|---------------|-------------|
| 01 | fixed-price-payment | receiver, payer, ipp, deployments | Fixed-amount payment with receiver-precomputed nonce |
| 02 | open-amount-payment | receiver, payer, ipp, deployments | Open-amount payment (payer determines the price) |
| 03 | pay-blind | payer, core, node, ipp, deployments | Blinded-amount payment (ZK proof hides the amount) |
| 04 | withdraw | ipp, receiver, node, deployments | Batch settlement (receiver withdraws funds) |
| 05 | deposit-credit | payer, ipp, deployments | Credit deposit (payer grants credit) |
| 06 | credit-draw | ipp, receiver, node, deployments | Credit draw (receiver uses granted credit) |
| 07 | credit-reclaim | ipp, payer, node, deployments | Credit reclaim (payer recovers expired credit) |
| 08 | refund | receiver, deployments | Refund flow |
| 09 | meta-transaction | payer, ipp, deployments | EIP-712 signature + relay gasless payment |
| 10 | merkle-tree-sync | tree, deployments | Merkle Tree sync and proof retrieval |
| 11 | proof-generation | node | Server-side ZK proof generation |
| 12 | react-integration | react, payer | React + Vite frontend integration |
| 13 | vue-integration | vue, payer | Vue 3 + Vite frontend integration |

## Running

CLI examples (01-11):

```bash
cd examples/01-fixed-price-payment
bash run.sh
```

Frontend examples (12-13):

```bash
cd examples/12-react-integration
bash run.sh
# Visit http://localhost:5173
```

## Dependency Notes

All examples reference local packages via `file:../../packages/<name>`, suitable for local development and debugging. After publishing, you can replace them with version numbers:

```json
// During development
"@invisi/payer": "file:../../packages/payer"

// After publishing
"@invisi/payer": "^0.1.0"
```

## Frontend Examples

Examples 12 (React) and 13 (Vue) use the Vite dev server. After running `pnpm dev`, visit `http://localhost:5173`. These two examples do not depend on `shared/env.ts`; configuration is written directly in the components.
