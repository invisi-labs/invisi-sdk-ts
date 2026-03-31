# 02 - Open Amount Payment

Open-amount payment example demonstrating tip/donation scenarios where the payer determines the amount. The receiver does not preset an amount; the payer negotiates via the endpoint.

## Packages Used

- `@invisi/receiver` -- Create payment requests
- `@invisi/payer` -- Build payment calldata
- `@invisi/ipp` -- Encode/decode IPP requests, IPPClient
- `@invisi/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY, RECEIVER_MASTER_KEY)
- Full flow requires a running endpoint (implementing the propose API)
