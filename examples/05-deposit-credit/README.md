# 05 - Deposit Credit

Credit deposit example demonstrating the flow of a payer granting credit to a receiver. The payer locks funds and generates a creditCommitment, which the receiver can later draw from as needed.

## Packages Used

- `@invisi/payer` -- Create credit calldata
- `@invisi/ipp` -- IPP request decoding, IPPClient (authorize API)
- `@invisi/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY)
- A running endpoint (implementing the authorize API)
