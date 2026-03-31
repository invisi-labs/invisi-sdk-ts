# 04 - Withdraw

Batch settlement example demonstrating how the receiver withdraws received payments from the protocol. Supports three modes: local ZK + local on-chain submission, local ZK + relay, and fully delegated to relay.

## Packages Used

- `@invisi-labs/ipp` -- IPPClient (withdraw API)
- `@invisi-labs/receiver` -- Build withdraw calldata
- `@invisi-labs/node` -- Generate ZK proof
- `@invisi-labs/deployments` -- Contract addresses

## Running

```bash
bash run.sh
```

## Prerequisites

- Configure `.env` (PRIVATE_KEY)
- A running endpoint (implementing the withdraw API)
- Confirmed paymentCommitments
