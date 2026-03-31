# 09 - Meta Transaction

Gasless payment example demonstrating zero-gas payments for users via EIP-712 signature + relay. The user only needs to sign; the relayer submits the transaction on their behalf.

## Packages Used

- `@invisi/payer` -- Build EIP-712 typed data
- `@invisi/ipp` -- IPPClient (relay API)
- `@invisi/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY)
- An endpoint that supports relay
