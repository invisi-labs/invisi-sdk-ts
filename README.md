# Invisi TypeScript SDK

Release preparation targets `1.2.4` for all eight packages; see [local package verification](RELEASE.md).

A capability SDK for ordinary private Notes and deferred Credit grants. Workspace packages keep cryptography, protocol codecs, proving, RPC transport, stateless preparation, managed sessions and UI bindings separate. Applications select their deployment, infrastructure, storage and signing capabilities explicitly.

| Package | Responsibility |
| --- | --- |
| `@invisi-labs/primitives` | Pure crypto, fields, wallet keys/capabilities, Note/Credit commitments and delivery codecs; no network or proof runtime. `/note` and `/credit` expose separate business modules. |
| `@invisi-labs/protocol` | Pure current contract ABIs, public DTOs, strict codecs, public inputs, signature digests, capacities and gas references; separate `/note` and `/credit` entries. |
| `@invisi-labs/prover` | Local witness construction, authenticated artifacts and explicit `/native`, `/wasm`, `/aggregate` backends. |
| `@invisi-labs/rpc` | Protocol RPC, Broadcaster and Provenance clients, deployment/registry bindings, response validation and transport errors. |
| `@invisi-labs/sdk` | Stateless preparation, external signing requests, proofs, output factories and calldata. Note/Credit public subpaths retain separate business types. |
| `@invisi-labs/session` | Inventory, selection, reservations, synchronization, history and operation recovery. |
| `@invisi-labs/react`, `@invisi-labs/vue` | Thin operation lifecycle bindings. |

## Core contract bindings

Contract bindings follow the current `invisi-core` compiler artifacts: `InvisiCore` / `IInvisiCore` and `InvisiCoreFactory` / `IInvisiCoreFactory`. Update direct binding imports and generated tuple type names accordingly. Generic Protocol objects, package names, `protocolAddress` / `protocol_address`, deployment catalog records, EIP-712 domains and wire encodings retain their existing meanings.

## Ordinary Notes

```ts
import { Invisi, Wallet, NoteOutput, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";

// Wallet requires complete 0i receiving material; use ownerAddress directly for identity-only operations.
const wallet = Wallet.fromAddress(receivingAddress);
const protocolRpc = new ProtocolRpcClient(protocolRpcUrl); // /v1 service
const protocol = await Protocol.fromRpc(protocolRpc, provider);
const invisi = new Invisi({ provider, protocolRpc, prover });
const session = await WalletSession.connect({
  invisi, wallet, protocol, store: new MemoryWalletStore(), signer,
});
const refresh = await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });
await refresh.decrypt(decryptor); // App-supplied DeliveryDecryptor
const output = await NoteOutput.create({
  chainId: protocol.context.chainId,
  protocolAddress: protocol.context.protocolAddress,
  tokenAddress,
  amount: 30n,
  recipient: { type: "invisi", address: recipientAddress },
});
const prepared = await session.prepareTransfer({ tokenAddress, outputs: [output] });
const review = prepared.preview();
const authorization = await prepared.exportWalletAuthorization();
const signature = await signer.signTypedData(authorization.domain, authorization.types, authorization.message);
const ready = await (await prepared.withWalletSignature(signature)).prove();
const transaction = await session.sendTransaction(ready);
await transaction.wait();
await (await session.resume(ready.id)).reconcile();
```

Memory storage is explicitly ephemeral. Persistent adapters use `/indexeddb` or `/sqlite` with an application-owned encrypted codec and key. Constructors start no background tasks. A deployed Protocol is multi-token; each operation selects one asset and mixed-token aggregation retains separate conservation.

Applications that own their inventory call `invisi.prepareTransfer({wallet,protocol,tokenAddress,inputs,outputs})` directly. Explicit `NoteInput` records contain `{note,commitment,treeId,leafIndex}`. Detached preparation validates all supplied records but does not access a wallet store, reserve inputs, broadcast or reconcile automatically.

Private authorization uses an external signing boundary:

```ts
const authorization = await prepared.exportWalletAuthorization();
const signature = await signer.signTypedData(authorization.domain, authorization.types, authorization.message);
const authorized = await prepared.withWalletSignature(signature);
const ready = await authorized.prove();
await transactionSigner.sendTransaction(await ready.exportTransaction());
```

Funding authorization, private spending authorization and gas payment are independent. Public funding requires exact ERC20 receipts; fee-on-transfer and rebasing behavior are unsupported. Explicit signature funding uses `exportFundingAuthorization()` after proving (shield needs no proof), followed by `withFundingSignature()`. Private circuit authorization supports EOA signatures; public funding, registry and revocation can use configured ERC-1271 verification.

## Deferred Credit

Creation registers private authority without principal deposits or ordinary Note inputs. A configured fee on creation/update/revocation is pulled from the owner wallet using its ERC20 allowance. A spender draw atomically collects gross approved ERC20 receipts from owner payer groups, deducts its fee, and issues the net ordinary Note to the selected recipient. Every consumed grant has a successor state; limits and usage remain private. A draw may combine grants from the same payer or different payers, with one private spender and one token.

```ts
const grant = await invisi.prepareCreateCredit({
  wallet: ownerWallet, protocol, tokenAddress,
  spender: merchantAddress, expiry,
  singleLimit: 100n, dailyLimit: 1000n,
  monthlyLimit: 10000n, availableCredit: 50000n, unlimited: false,
});
// Export owner wallet authorization, attach its signature, then prove.

const draw = await invisi.prepareDrawCredit({
  wallet: merchantWallet, protocol, tokenAddress,
  creditInputs: selectedSpenderStates,
  credits: [{ credit: grantCommitment, amount: 30n }],
  recipient: recipientAddress,
});
// Export merchant wallet authorization, attach its signature, then prove.
```

`CreditState` stores uint128 `availableCredit` and strict boolean `unlimited`, separately from three single/day/month limits and five usage counters. Finite zero is exhausted. Draw debits gross available credit; unlimited states always store zero available credit but still accumulate gross usage and totalSpent. Day/month counters reset only at UTC period rollover.

`prepareUpdateCredit` accepts mutually exclusive uint128 `increaseAvailableCredit` / `decreaseAvailableCredit` deltas, never an absolute balance. Both may be zero. Usage, including historical totalSpent, remains unchanged. Unlimited mode defaults to the input mode: unlimited results require zero deltas and clear the balance; switching to finite starts from zero plus this update's increase and may remain exhausted. Finite decreases cannot exceed the old balance, and arithmetic fits uint128. Three limits and expiry remain owner-editable; zero disables a limit without disabling usage tracking. Both expiries cover the request deadline. Optional owner create/update/revoke fees do not consume grant quota; draws produce `totalAmount - feeAmount` while charging gross usage and quota. Quoting/retrying preserves the original delta and frozen input, never reapplies it to a prepared successor.

`prepareRevokeCredit({wallet,protocol,tokenAddress,shard,slot,...})` needs no latest private state. Use public `exportRevocationAuthorization()` / `withRevocationSignature()` or specify the direct owner `caller` and call `ready()`. Revocation needs no ZK proof, remains available during pauses and cannot reclaim already issued Notes. It has no principal refund. Optional `fee: {recipient, amount}` is bound into owner authorization and pulled from the owner wallet. Public owner/token/shard/slot references link grant activity; private policy and spender fields stay private.

`CreditState` is a scoped private grant preimage. `computeCreditCommitment(state)` and `recoverCreditState` live in the Credit module. Credit role envelopes retain both receiving-key snapshots; recovery authenticates masked debits even when successor deliveries cannot be decrypted. Credit uses envelope0x82 (minimum485 bytes), while ordinary Notes use0x01 (minimum160 bytes). Opaque application payloads are copied unchanged and never interpreted as financial fields.

## Proving and aggregation

Current releases pin Noir/Noir JS1.0.0 and BB6.0.0, with Credit manifest7/format8 and fee-binding authorization domains v4. The SDK authenticates77 circuit artifacts and their target-specific verification keys:28 direct Note circuits,34 aggregate outers and15 direct Credit circuits. Direct Note capacities are C1..C10 and C20..C190 by10. Credit draws select C1/2/3/4/5/10/20/30/40/50/60/70/80. Credit create/draw/update are direct-only.

Without a Broadcaster quote, `prove({execution:"aggregate"})` selects the recursive target for C1..C10 and omission selects direct submission. With a quote, `prove()` follows its signed `quote.execution`: `direct` uses the EVM target and `aggregate` uses a recursive member. A manual `execution:"single"` or `"aggregate"` must agree with the quote. Export standalone recursive results with `exportAggregateMember()` and use `Aggregator` from `/aggregate`. Dedicated outers accept1/2/5 members at one capacity; mixed C1..C5 outers accept2/3/4/5 members. Canonical capacities, request ordering, context, cross-member uniqueness and public trusted key pins are validated. The proving service receives a local witness only through explicit capability access; remote public verification never sends a private witness.

## Discovery and gas

Protocol RPC APIv1 separates Note and Credit data. Credit indexed states retain two role deliveries per physical leaf. Session discovery combines candidate transaction references internally and verifies canonical Chain RPC receipts, commitments, role decryption, membership and consumption. Detection is explicit, untrusted filtering; observed or indexed history is not a completeness proof. Keep uncertain inputs reserved until canonical settlement or genuine expiry is established.

`prepared.estimateGas()` and managed `operation.estimateGas()` synchronously estimate gas from transaction structure and the embedded benchmark table. They work before authorization, proving or ERC20 approval and require no provider. The estimator never exports a transaction, changes its state or performs an RPC simulation.

Valid direct operations return `available: true` and positive `gasUnits`: Shield1–10 outputs, all supported transact input/output combinations including funding and withdrawal, Credit create/update/revoke, and draw1–80. All local previews use `source: "benchmark"`. `statistic: "median"` identifies measured shapes; `statistic: "estimate"` identifies receipt-calibrated estimates. Results include `protocolCommit`, conditions and assumptions. Additional payload, source trees, Permit and funding signatures have explicit model allowances. Illegal shapes throw; recursive aggregate previews remain explicitly unsupported. Single-output public deposits use Shield, not transact.

To refresh measurements, run `node scripts/measure-gas.mjs ../invisi-core` against a clean protocol develop checkout. Existing successful reports can be imported with `node scripts/generate-gas-model.mjs <note-report.json> <credit-report.json> <control-report.json>`. The generator rejects mixed revisions and checks held-out shape error before replacing the embedded data.

The result is an approximate gas count, not a guaranteed transaction gas limit, a live fee or a Broadcaster quote. Applications choose fee prices and safety budgets, manage approval/balances, and may explicitly simulate the final call through their own EVM provider. `session.sendTransaction` requires a positive caller-supplied `gasLimit` so ethers cannot implicitly simulate on the SDK's behalf. There is no public `getGasReference` API.

## Development

Use Node20+ and pnpm9+:

```sh
pnpm install
pnpm sync:protocol ../invisi-core
pnpm build
pnpm test
pnpm lint
pnpm check:browser
pnpm check:surface
pnpm check:session
```

Artifact synchronization reads the current authenticated manifests and removes retired artifacts. Deterministic protocol/vector and gas-model generators live in `scripts/` and `packages/protocol/scripts/`. Optional native/WASM integration tests use `BB_BINARY_PATH` and `INVISI_TEST_WASM=1`.

## App wallet boundary

`Wallet` contains public receiving material only. The App owns key storage, unlocking, decryption and signing. The SDK includes no native wallet transport or App bridge. Authorization can use ethers EIP-712 signing directly.

Inject a `DeliveryDecryptor` with `decryptNote(envelope, context)` and `decryptCredit(envelope, context)`. Each returns authenticated plaintext `Uint8Array`, explicit `null` for a known nonrecipient, or `{ status: "authentication-failed" }` for ambiguous AEAD failure; operational failures reject. Optional native batch `detect` receives full context and clues without exporting detection keys. `authenticatedDecryptor(ownerAddress, decryptor, receivingKeys)` validates plaintext context and commitments. Session shares public history across accounts and commits each private batch with its own cursor through `pending.decrypt(decryptor)`. Unresolved candidates remain retryable and make asset completeness unknown. See [shared history APIs](packages/session/README.md#shared-public-history). See [example integration](examples/app-decryptor.ts).

The optional low-level wallet wire codecs remain transport-neutral validation utilities for application-defined integrations; normal examples and Session refresh do not use their request/response envelopes. Keys never enter SDK transaction configuration. Plaintext Note/Credit openings and proving witnesses may enter JavaScript at explicit boundaries.

The App decryptor must authenticate the ciphertext (including the AEAD tag) before returning plaintext. Commitment checks validate financial contents; they do not independently authenticate opaque memo bytes.

## Optional Provenance tracking

Discover supported-token services before exposing a concrete transaction:

```ts
const clients = await protocol.getBroadcasters({ tokenAddress, signal });
const client = clients[0];
if (!client) throw Error("No broadcaster supports this token");
const quoted = await client.quote(prepared, { maxFeeAmount });
```

The seventh EIP-712 quote field is `execution` (`direct` or `aggregate`), after `requestHash`; it is required and verified. Cold-period quotes may choose direct execution. After attaching the wallet signature to the quoted operation, call `authorized.prove()` without manually selecting a route. Aggregate quotes accept unfunded private C1..C10 transfers only. The SDK submits canonical public member data plus `memberProof`; it never exports those bytes as a directly sendable transaction or uploads private openings. The Broadcaster owns batching and one-member fallback, while charging according to its direct-based quote.

`queued` and `proving` are accepted service jobs, not chain confirmation. Save the opaque submission ID and poll `client.status(id)`. Known IDs are queried without resending, including when lookup fails. An ID-less lost response retries the exact frozen data, member proof and Source evidence. Session persists that envelope before network submission and retains input reservations until canonical primary-chain reconciliation; service `rejected` or `expired` alone cannot release them.

Discovery reads registered credentials from Protocol RPC and checks token capability only; it does not estimate gas or fees. Exact shape acceptance and pricing belong to the concrete quote. Client construction requires no Source policy switch; first submission reads service requirements and the server enforces Source acceptance.

The independent Provenance feature keeps source recognition separate from protocol spendability. Relay use is optional and restricted to each operator's supported tokens. In the relay route quotation only prices/signs; source proof is generated from the final ready transaction, and Broadcaster verifies source on submit before sending. Direct protocol submission and source submission are independent App-controlled steps, in either order. Successful private-input preflight returns a durable tracking ID; default recovery persists it before broadcast permission and uses automatic chain matching, with bounded tracking waits and primary reconciliation. Normal confirmation does not require another `submitProof`. Explicit `prepareDirect` / `PrepareDirect` / `prepare_direct` and manual submission remain available for an intentionally selected self-broadcast/reproof fallback; missing tracking never silently switches modes. App integration, raw openings, signing and nonce reservations remain host-owned. See the flat [Provenance examples](examples/07-broadcaster/).

The dependency order is `primitives → protocol`, then independent `prover` and `rpc`, then stateless `sdk`, then managed `session`. Session also uses public protocol DTOs directly. React/Vue depend on SDK/session only. `pnpm check:boundaries` enforces this DAG and rejects network execution or proof runtimes in pure modules. Long-term protocol and Provenance design lives in the [protocol documentation](https://github.com/invisi-lab/protocol-docs).

Cross-project acceptance belongs to this SDK workspace. From the SDK repository root, run the explicit integration entry points after preparing the current protocol build, local services and SDK toolchains:

```sh
node test-support/integration/provenance-e2e.mjs --sdk
node test-support/integration/provenance-broadcaster-e2e.mjs --highlevel=typescript
```

Add `--browser`, `--reorg` or `--replicas` for the existing optional scenarios. These runners use `invisi-core` public fixtures and retain its existing `.tools` run directories; protocol unit tests do not load or build SDK checkouts.

## Native chain finality

`ChainReader.getBlockByTag('latest' | 'safe' | 'finalized')` is an optional native-tag capability. `EthersChainReader` implements it without deriving safe/finalized from elapsed time or block counts. `readChainFinality(reader)` returns `{latest, safe, finalized}` heads, each `{status, block}`, with status `available`, `unsupported`, `unavailable`, or `inconsistent`. Heads are checked against canonical numeric reads and native ordering; unsupported tags never become available through a fallback. Custom readers can throw `FinalityUnsupportedError` for unsupported tags and `FinalityInconsistentError` for malformed/conflicting chain responses. Discovery and transaction prechecks continue using latest state.

Explicit `PaymentNote.verify`, `PaymentNote.verifySpendable`, and `DisclosureVerifier` use `finality: 'finalized'` by default. Select `finality: 'safe'` or `'latest'` explicitly when needed. An unavailable or unsupported selected native tag fails verification. PaymentNote membership is checked at the earlier of the indexed head and the selected native head; spendability still checks current nullifiers/root acceptance at latest. Disclosure evidence/results expose the requested `finality`, rather than a numeric confirmation count.

Receipt inclusion and native finality are independent of transaction success. `readTransactionConfirmation(reader, hash)`, detached `PreparedTransaction.getConfirmation(hash)`, and managed `Operation.getConfirmation()` report `{level: 'pending' | 'included' | 'safe' | 'finalized', status, block}` from the application's chain reader. The managed operation reads its associated transaction hash; call `track` or reconcile an externally submitted hash to associate it. These observations do not mutate inventory, release reservations, prove operation effects, or change receipt wait/reconciliation behavior. For aggregate transactions, each member remains subject to existing canonical receipt/member matching during reconciliation. The broadcaster example supports `--wait-finalized` as an explicit independent native-finality wait.

`ProtocolRpcClient.getStatus().finality`, when supplied by the service, describes that service's snapshot. Available claims must also be canonical and at or below the primary reader's same native tag. Primary lag returns unavailable; absent native capability returns unsupported. `readChainFinality` reads the application's live primary heads directly. The SDK is an observational client, not a consensus light client with a durable global finality fence.

Broadcaster status optionally includes its own `confirmation` object with a decimal-string block number, hash and numeric Unix timestamp. It preserves `confirmed`/`reverted` receipt semantics. Queued/proving work has no chain confirmation. Relay confirmation is untrusted metadata and never substitutes for the independent chain reads above. Provenance Source rules use `finality: 'finalized'`; depth and time thresholds are not finality settings.

### Scheduled Broadcaster publication

`client.quote(prepared, { maxFeeAmount, schedule: { publishAfter, executeBefore? }, persistSchedule })` freezes a scheduled quote before authorization/proving. Unix times are `bigint` in this convenience API and decimal strings on the wire. Omitted `executeBefore` uses the relay's advertised default window; call `client.scheduling(context)` for configured limits. Prepare the operation with an authorization deadline at least `executeBefore + minDeadlineSlackSeconds`; the SDK rejects insufficient deadlines. Ordinary quote signatures remain unchanged; scheduled quotes use `ScheduledQuote` and bind all three nested `quote.schedule` fields.

The SDK generates a random 32-byte cancellation secret. Managed Session operations atomically save it with the quote in their wallet store; use a persistent encrypted adapter for restart recovery. Detached prepared transactions require `persistSchedule` to save their scoped secret and signed quote, then the frozen submission before sending. The broadcaster allocates an opaque ID; the handle has no ID before the acknowledgement. The SDK saves the exact returned ID before returning submission success. The signed quote contains only Keccak-256 of the raw secret. Retrieve the same record with `broadcasterScheduleHandle()`. Never log its secret. After a lost response without an ID, retry `client.submit(originalReadyHandle)` (or resume the original Session operation and submit it). A detached application that persisted the full handle can call `retryScheduledSubmission(handle, context, persistSchedule)` after restart; a secret-only handle cannot recover an unknown ID. This replays the frozen payload without requoting or reproving. Use `client.cancel(preparedOrOperation)` for ordinary or managed transaction handles. Use `client.recoverScheduled(handle, context)` only once a real returned ID has been saved, and `client.cancelScheduled(handle, context)` for an independently persisted recovery handle; raw RPC users can call `cancelTransaction(id, cancelToken)`. Cancellation errors preserve RPC codes: `-32020` unauthorized, `-32021` too late, `-32022` unavailable. A retry must retain the original quote, secret and frozen submission. Failed acknowledgement persistence also requires that same replay. Managed `client.cancel(operation)` also requires a saved returned ID and makes no remote calls when it is absent: explicitly submit the resumed original operation to recover its ID first, then cancel. A never-submitted operation must be abandoned locally and is never submitted just to cancel it.

Scheduled status adds `scheduled`, `preparing`, and `cancelled`, with decimal-string `publishAfter`/`executeBefore`. All existing execution and confirmation states retain their meanings. For a managed Session, `client.cancel(operation)` requires acknowledged cancellation and independently reconciles canonical input consumption before releasing reservations; errors or uncertain cancellation retain reservations. A persisted cancellation acknowledgement allows canonical reconciliation to be retried without reconnecting to the relay. Inputs already consumed require transaction reconciliation before releasing reservations. Repeating a completed cancellation returns its stored acknowledgement. Detached cancellation does not mutate a Session store. Scheduling does not change normal Provenance admission or pre-send checks. See the flat [scheduled/cancel/recovery example](examples/07-broadcaster/04-scheduled-cancel-recovery.ts).

Run the owned-chain native-proof scheduling acceptance with `node test-support/integration/provenance-broadcaster-e2e.mjs --highlevel=typescript --schedule=both`. It proves and cancels one request, recovers its saved scoped capability, then proves a distinct request from the still-unspent input and verifies delayed inclusion plus normal Source recognition. This explicit mode skips the unrelated aggregate batching scenarios; the default suite remains unchanged.

Use `--highlevel=typescript --schedule=aggregate` for the separate native recursive-member / native outer scheduling scenario. It verifies deferred queue entry, aggregate transaction member matching, finalized inclusion and ordinary Source recognition.

`ProtocolRpcClient.getNoteFromTrustedRpc(context, commitment, "safe" | "finalized")`
uses the `invisi_getNote` confirmation selector with explicit constructor
`deployment` pins and no chain reader. Discovery through `getDeployment` alone does
not authorize trusted confirmation, including on clients cloned with `withReader`. Its distinct `TrustedNoteLookup` result is either `pending` (an explicit
reason with no partial output/proof) or `confirmed`. The client validates deployment
pins, response bindings, block consistency, head coverage and the Merkle proof.
Canonicality, successful receipt authentication and native finality remain claims
trusted to the selected RPC publisher. A pending result is not proof of no payment.
The existing `getNote(context, commitment, block)` continues to authenticate through
an independent chain reader.

## Contributing

Open a focused GitHub issue or pull request describing the problem, scope, and validation. Run `pnpm test` and `pnpm lint` (plus the relevant package/release checks) for your change. Never include private keys, credentials, or private witnesses in issues, pull requests, logs, or fixtures.
