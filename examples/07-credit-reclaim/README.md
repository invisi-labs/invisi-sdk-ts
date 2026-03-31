# 07 - Credit Reclaim

Credit reclaim example demonstrating how the payer recovers unused credit after it expires. Any portion not drawn by the receiver before expiry can be reclaimed by the payer.

## Packages Used

- `@invisi-labs/ipp` -- IPPClient (creditReclaim API)
- `@invisi-labs/payer` -- Build creditReclaim calldata
- `@invisi-labs/node` -- Generate ZK proof
- `@invisi-labs/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY)
- An expired creditCommitment
