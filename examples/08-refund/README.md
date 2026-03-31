# 08 - Refund

Refund example demonstrating the receiver initiating a full or partial refund. The refund is linked to the original payment via refundLink, and the payer can discover refunds through on-chain events.

## Packages Used

- `@invisi/receiver` -- Build refund calldata
- `@invisi/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY)
- A confirmed original paymentCommitment
