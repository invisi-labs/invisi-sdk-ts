# 01 - Fixed Price Payment

Fixed-amount payment example demonstrating the single-payer invoice mode with receiver-precomputed nonce (Mode 1a) and multi-payer scan mode (Mode 1b).

## Packages Used

- `@invisi-labs/receiver` -- Create payment requests
- `@invisi-labs/payer` -- Build payment calldata, verify paymentCommitment
- `@invisi-labs/ipp` -- Encode/decode IPP requests
- `@invisi-labs/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY, RECEIVER_MASTER_KEY)
- Mode 1b requires a running endpoint
