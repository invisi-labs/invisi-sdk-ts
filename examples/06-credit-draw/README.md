# 06 - Credit Draw

Credit draw example demonstrating how the receiver draws funds on demand from the payer's granted credit. Requires generating a ZK proof to prove the draw is legitimate.

## Packages Used

- `@invisi-labs/ipp` -- IPPClient (creditDraw API)
- `@invisi-labs/receiver` -- Build creditDraw calldata
- `@invisi-labs/node` -- Generate ZK proof
- `@invisi-labs/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY)
- An existing creditCommitment
