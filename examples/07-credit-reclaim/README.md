# 07 - Credit Reclaim

Credit reclaim example demonstrating how the payer recovers unused credit after it expires. Any portion not drawn by the receiver before expiry can be reclaimed by the payer.

## Packages Used

- `@invisi/ipp` -- IPPClient (creditReclaim API)
- `@invisi/payer` -- Build creditReclaim calldata
- `@invisi/node` -- Generate ZK proof
- `@invisi/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY)
- An expired creditCommitment
