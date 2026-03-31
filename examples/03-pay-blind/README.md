# 03 - Pay Blind

Blinded-amount payment example demonstrating the full flow of using a ZK proof to hide the payment amount. The payer generates the proof, and the chain verifies it without revealing the exact amount.

## Packages Used

- `@invisi-labs/payer` -- Build payBlind calldata, verify paymentCommitment
- `@invisi-labs/core` -- Compute changeCommitment
- `@invisi-labs/node` -- Generate ZK proof
- `@invisi-labs/ipp` -- IPP request decoding, IPPClient
- `@invisi-labs/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY)
- Install nargo + bb (Noir ZK toolchain)
- A running endpoint (implementing the propose API)
- An existing UTXO (used as input for the blind payment)
