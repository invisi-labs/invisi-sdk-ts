# Invisi TypeScript SDK

A capability SDK for ordinary private Notes and deferred Credit grants. Eight workspace packages keep cryptography, protocol codecs, proving, RPC transport, stateless preparation, managed sessions and UI bindings separate. Applications select their deployment, infrastructure, storage and signing capabilities explicitly.

| Package | Responsibility |
| --- | --- |
| `@invisi-labs/core` | Wallet capabilities, Note/Credit commitments, encryption, recovery and delivery primitives. `/note` and `/credit` expose separate business modules. |
| `@invisi-labs/protocol` | Current contract ABIs, canonical request/statement codecs, local witnesses, deployment bindings and registry operations; separate `/note` and `/credit` entries. |
| `@invisi-labs/prover` | Authenticated artifacts and explicit `/native`, `/wasm`, `/aggregate` backends. |
| `@invisi-labs/rpc` | Protocol RPC APIv1 with independent Note/Credit query surfaces and canonical anchor checks. |
| `@invisi-labs/sdk` | Stateless preparation, external signing requests, proofs, output factories and calldata. Note/Credit public subpaths retain separate business types. |
| `@invisi-labs/session` | Inventory, selection, reservations, synchronization, history and operation recovery. |
| `@invisi-labs/react`, `@invisi-labs/vue` | Thin operation lifecycle bindings. |

## Ordinary Notes

```ts
import { Invisi, Wallet, NoteOutput, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";

const wallet = await Wallet.fromPrivateKey(evmPrivateKey);
const protocolRpc = new ProtocolRpcClient(protocolRpcUrl); // /v1 service
const protocol = await Protocol.fromRpc(protocolRpc, provider);
const invisi = new Invisi({ provider, protocolRpc, prover });
const session = await WalletSession.connect({
  invisi, wallet, protocol, store: new MemoryWalletStore(), signer,
});
await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });
const output = await NoteOutput.create({
  chainId: protocol.context.chainId,
  protocolAddress: protocol.context.protocolAddress,
  tokenAddress,
  amount: 30n,
  recipient: { type: "invisi", address: recipientAddress },
});
const prepared = await session.prepareTransfer({ tokenAddress, outputs: [output] });
const review = prepared.preview();
const ready = await (await prepared.authorize()).prove();
const transaction = await session.sendTransaction(ready);
await transaction.wait();
await (await session.resume(ready.id)).reconcile();
```

Memory storage is explicitly ephemeral. Persistent adapters use `/indexeddb` or `/sqlite` with an application-owned encrypted codec and key. Constructors start no background tasks. A deployed Protocol is multi-token; each operation selects one asset and mixed-token aggregation retains separate conservation.

Applications that own their inventory call `invisi.prepareTransfer({wallet,protocol,tokenAddress,inputs,outputs})` directly. Explicit `NoteInput` records contain `{note,commitment,treeId,leafIndex}`. Detached preparation validates all supplied records but does not access a wallet store, reserve inputs, broadcast or reconcile automatically.

Private authorization uses an external signing boundary:

```ts
const request = await prepared.exportWalletAuthorization();
const signature = await ownerSigner.signTypedData(request.domain, request.types, request.message);
const ready = await (await prepared.withWalletSignature(signature)).prove();
await transactionSigner.sendTransaction(await ready.exportTransaction());
```

Funding authorization, private spending authorization and gas payment are independent. Public funding requires exact ERC20 receipts; fee-on-transfer and rebasing behavior are unsupported. Explicit signature funding uses `exportFundingAuthorization()` after proving (shield needs no proof), followed by `withFundingSignature()`. Private circuit authorization supports EOA signatures; public funding, registry and revocation can use configured ERC-1271 verification.

## Deferred Credit

Creation registers private authority without principal deposits or ordinary Note inputs. A configured fee on creation/update/revocation is pulled from the owner wallet using its ERC20 allowance. A spender draw atomically collects gross approved ERC20 receipts from owner payer groups, deducts its fee, and issues the net ordinary Note to the selected recipient. Every consumed grant has a successor state; limits and usage remain private. A draw may combine grants from the same payer or different payers, with one private spender and one token.

```ts
const grant = await invisi.prepareCreateCredit({
  wallet: ownerPublicWallet, protocol, tokenAddress,
  spender: merchantAddress, expiry,
  singleLimit: 100n, dailyLimit: 1000n,
  monthlyLimit: 10000n, lifetimeLimit: 50000n,
});
// Export owner wallet authorization, attach its signature, then prove.

const draw = await invisi.prepareDrawCredit({
  wallet: merchantPublicWallet, protocol, tokenAddress,
  creditInputs: selectedSpenderStates,
  credits: [{ credit: grantCommitment, amount: 30n }],
  recipient: recipientAddress,
});
// Export merchant wallet authorization, attach its signature, then prove.
```

`prepareUpdateCredit` changes limits/expiry while preserving all five usage fields and immutable identities, key and revocation namespace. Zero disables a limit; usage continues accumulating. Day/month counters reset only at UTC period rollover. Both old and new expiry must cover the request deadline. Every Credit operation accepts optional `fee: {recipient, amount}`; draw usage/limits count the gross debit, while the recipient Note receives `totalAmount - feeAmount`. Fees accrue through the same beneficiary fee accounting as ordinary transactions.

`prepareRevokeCredit({wallet,protocol,tokenAddress,shard,slot,...})` needs no latest private state. Use public `exportRevocationAuthorization()` / `withRevocationSignature()` or specify the direct owner `caller` and call `ready()`. Revocation needs no ZK proof, remains available during pauses and cannot reclaim already issued Notes. It has no principal refund. Optional `fee: {recipient, amount}` is bound into owner authorization and pulled from the owner wallet. Public owner/token/shard/slot references link grant activity; private policy and spender fields stay private.

`CreditState` is a scoped private grant preimage. `computeCreditCommitment(state)` and `recoverCreditState` live in the Credit module. Credit role envelopes retain both receiving-key snapshots; recovery authenticates masked debits even when successor deliveries cannot be decrypted. Credit uses envelope0x82 (minimum484 bytes), while ordinary Notes use0x01 (minimum160 bytes). Opaque application payloads are copied unchanged and never interpreted as financial fields.

## Proving and aggregation

Current releases pin Noir/Noir JS1.0.0 and BB6.0.0, with Credit manifest7/format8 and fee-binding authorization domains v4. The SDK authenticates77 circuit artifacts and their target-specific verification keys:28 direct Note circuits,34 aggregate outers and15 direct Credit circuits. Direct Note capacities are C1..C10 and C20..C190 by10. Credit draws select C1/2/3/4/5/10/20/30/40/50/60/70/80. Credit create/draw/update are direct-only.

After Note wallet authorization, `prove({execution:"aggregate"})` selects the recursive target for C1..C10; omission selects direct submission. Export recursive results with `exportAggregateMember()` and use `Aggregator` from `/aggregate`. Dedicated outers accept1/2/5 members at one capacity; mixed C1..C5 outers accept2/3/4/5 members. Canonical capacities, request ordering, context, cross-member uniqueness and public trusted key pins are validated. The proving service receives a local witness only through explicit capability access; remote public verification never sends a private witness.

## Discovery and gas

Protocol RPC APIv1 separates Note and Credit data. Credit indexed states retain two role deliveries per physical leaf. Session discovery combines candidate transaction references internally and verifies canonical Chain RPC receipts, commitments, role decryption, membership and consumption. Detection is explicit, untrusted filtering; observed or indexed history is not a completeness proof. Keep uncertain inputs reserved until canonical settlement or genuine expiry is established.

`prepared.getGasReference()` returns a documented scenario reference, with source conditions and `available:false` when unsupported. `getDocumentedGasReference(shape)` exposes the curated exact reference catalog from protocol-docs sections5.1..5.6. Documented medians do not contain raw receipt fingerprints. Draw measurements cover distinct payers only; same-payer and current aggregate costs are unavailable. No arbitrary shape extrapolation is performed.

`await ready.estimateGas({from?})` uses the configured ethers provider on the final transaction and returns `{source:"rpc",gasUnits}`. It requires a ready handle. Applications separately choose current fee prices and transaction budgets.

## Development

Use Node20+ and pnpm9+:

```sh
pnpm install
pnpm sync:protocol ../invisi-protocol
pnpm build
pnpm test
pnpm lint
pnpm check:browser
pnpm check:surface
pnpm check:session
```

Artifact synchronization reads the current authenticated manifests and removes retired artifacts. Deterministic protocol/vector and documented-gas generators live in `scripts/` and `packages/protocol/scripts/`. Optional native/WASM integration tests use `BB_BINARY_PATH` and `INVISI_TEST_WASM=1`.
