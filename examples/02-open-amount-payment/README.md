# 02 - Open Amount Payment

Open-amount payment example demonstrating tip/donation scenarios where the payer determines the amount. The receiver does not preset an amount; the payer negotiates via the endpoint.

## Packages Used

- `@invisi-labs/receiver` -- Create payment requests
- `@invisi-labs/payer` -- Build payment calldata
- `@invisi-labs/ipp` -- Encode/decode IPP requests, IPPClient
- `@invisi-labs/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY, RECEIVER_MASTER_KEY)
- Full flow requires a running endpoint (implementing the propose API)
