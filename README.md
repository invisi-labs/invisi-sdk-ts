# Invisi TypeScript SDK

Workspace manifests currently use `1.3.6`. The Payment Router package follows the same fixed release group; see [local package verification](RELEASE.md).

A capability SDK for ordinary private Notes and deferred Credit grants. Workspace packages keep cryptography, protocol codecs, proving, RPC transport, stateless preparation, managed sessions and UI bindings separate. Applications select their deployment, infrastructure, storage and signing capabilities explicitly.

| Package | Responsibility |
| --- | --- |
| `@invisi-labs/primitives` | Pure crypto, fields, wallet keys/capabilities, Note/Credit commitments and delivery codecs; no network or proof runtime. `/note` and `/credit` expose separate business modules. |
| `@invisi-labs/protocol` | Pure current contract ABIs, public DTOs, strict codecs, public inputs, signature digests, capacities and gas references; separate `/note` and `/credit` entries. |
| `@invisi-labs/prover` | Local witness construction, authenticated artifacts and explicit `/native`, `/wasm`, `/aggregate` backends. |
| `@invisi-labs/rpc` | Protocol RPC, Broadcaster and Provenance clients, deployment/registry bindings, response validation and transport errors. |
| `@invisi-labs/sdk` | Stateless preparation, external signing requests, proofs, output factories and calldata. Note/Credit public subpaths retain separate business types. |
| `@invisi-labs/payment-router` | Canonical native/ERC20 PaymentRouter payments, V3/0x adapters, delegated native relay and verified Broadcaster envelopes. |
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

`CreditState` identifies each grant with a positive uint128 `grantId`, generated locally before proving with `generateCreditGrantId()` or provided explicitly. Grant IDs never change during draws, updates, recovery or quote rebuilding. IDs are scoped by chain, Core, owner and token; different IDs can be created concurrently without allocating a shared next slot. `getCreditStatus` returns 0 for unknown, 1 for active and 2 for revoked; draws and updates require active status. Owner revocation also accepts an unknown ID, preventing its future creation (0 to 2), and revoked status is terminal. Protocol version remains 1.

`CreditState` stores uint128 `availableCredit` and strict boolean `unlimited`, separately from three single/day/month limits and five usage counters. Finite zero is exhausted. Draw debits gross available credit; unlimited states always store zero available credit but still accumulate gross usage and totalSpent. Day/month counters reset only at UTC period rollover.

Credit creation uses the grant-ID ABI, including pure creation with `hasInitialPayment: false`. For atomic creation, `initialPayment.amount` is the gross owner debit. Optional `initialPayment.netAmount` pins the positive merchant Note amount and requires `amount === netAmount + fee.amount`; broadcaster quotes rebuild the gross debit, grant usage, commitments and proof statement while preserving that net amount. The IPP adapter sets this pin from the request amount. Quote before reviewing or approving the owner debit, then sign and prove the quoted operation.

`prepareUpdateCredit` accepts mutually exclusive uint128 `increaseAvailableCredit` / `decreaseAvailableCredit` deltas, never an absolute balance. Both may be zero. Usage, including historical totalSpent, remains unchanged. Unlimited mode defaults to the input mode: unlimited results require zero deltas and clear the balance; switching to finite starts from zero plus this update's increase and may remain exhausted. Finite decreases cannot exceed the old balance, and arithmetic fits uint128. Three limits and expiry remain owner-editable; zero disables a limit without disabling usage tracking. Both expiries cover the request deadline. Optional owner create/update/revoke fees do not consume grant quota; draws produce `totalAmount - feeAmount` while charging gross usage and quota. Quoting/retrying preserves the original delta and frozen input, never reapplies it to a prepared successor.

`prepareRevokeCredit({wallet,protocol,tokenAddress,grantId,...})` needs no latest private state. Use public `exportRevocationAuthorization()` / `withRevocationSignature()` or specify the direct owner `caller` and call `ready()`. Revocation needs no ZK proof, remains available during pauses and cannot reclaim already issued Notes. It has no principal refund. Optional `fee: {recipient, amount}` is bound into owner authorization and pulled from the owner wallet. Public owner/token/grantId references link grant activity; private policy and spender fields stay private.

`CreditState` is a scoped private grant preimage. Validated owner and spender identities normalize to lowercase 20-byte EVM addresses; hex casing, including checksum formatting, does not change authority, payer grouping or committed address values. `computeCreditCommitment(state)` and `recoverCreditState` live in the Credit module. Credit role envelopes retain both receiving-key snapshots; recovery authenticates masked debits even when successor deliveries cannot be decrypted. Credit uses envelope 0x84 (minimum 491 bytes), while ordinary Notes use 0x01 (minimum 160 bytes). Opaque application payloads are copied unchanged and never interpreted as financial fields.

## Proving and aggregation

Current releases pin Noir/Noir JS 1.0.0 and BB 6.0.0, with Credit manifest 8/format 9 and authorization domains `.GrantId.Uint128.v1`. The SDK authenticates 78 circuit artifacts and their target-specific verification keys: 28 direct Note circuits, 34 aggregate outers and 16 direct Credit circuits (including creation with initial payment). Direct Note capacities are C1..C10 and C20..C190 by10. Credit draws select C1/2/3/4/5/10/20/30/40/50/60/70/80. Credit create/draw/update are direct-only.

Without a Broadcaster quote, `prove({execution:"aggregate"})` selects the recursive target for C1..C10 and omission selects direct submission. With a quote, `prove()` follows its signed `quote.execution`: `direct` uses the EVM target and `aggregate` uses a recursive member. A manual `execution:"single"` or `"aggregate"` must agree with the quote. Export standalone recursive results with `exportAggregateMember()` and use `Aggregator` from `/aggregate`. Dedicated outers accept1/2/5 members at one capacity; mixed C1..C5 outers accept2/3/4/5 members. Canonical capacities, request ordering, context, cross-member uniqueness and public trusted key pins are validated. The proving service receives a local witness only through explicit capability access; remote public verification never sends a private witness.

## Discovery and gas

Protocol RPC APIv1 separates Note and Credit data. Credit indexed states retain two role deliveries per physical leaf. Session discovery combines candidate transaction references internally and verifies canonical Chain RPC receipts, commitments, role decryption, membership and consumption. Detection is explicit, untrusted filtering; observed or indexed history is not a completeness proof. Keep uncertain inputs reserved until canonical settlement or genuine expiry is established.

`prepared.estimateGas()` and managed `operation.estimateGas()` synchronously estimate gas from transaction structure and the embedded benchmark table. They work before authorization, proving or ERC20 approval and require no provider. The estimator never exports a transaction, changes its state or performs an RPC simulation.

The embedded Credit gas measurements predate the grant-ID storage layout and retain their original release identity. They are an approximate preview until remeasured against the current Core; they do not establish current create, draw or pre-revocation gas costs.

Valid direct operations return `available: true` and positive `gasUnits`: Shield1–10 outputs, all supported transact input/output combinations including funding and withdrawal, Credit create/update/revoke, and draw1–80. All local previews use `source: "benchmark"`. `statistic: "median"` identifies measured shapes; `statistic: "estimate"` identifies receipt-calibrated estimates. Results include `protocolCommit`, conditions and assumptions. Additional payload, source trees, Permit and funding signatures have explicit model allowances. Illegal shapes throw; recursive aggregate previews remain explicitly unsupported. Single-output public deposits use Shield, not transact.

Externally collected measurement reports can be imported with `node scripts/generate-gas-model.mjs <note-report.json> <credit-report.json> <control-report.json>`. The generator rejects mixed revisions and checks held-out shape error before replacing the embedded data.

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

Prepare a relayed Shield or funded transfer with signature funding (the default). Prepare selects the current funding nonce and deadline. Quote uses those frozen terms and the selected Notes. For private fee funding, set the existing `fee: { recipient, amount }` preparation option to reserve enough private value. A quote that needs another Note or a caller-to-signature funding change raises `InvisiError` with code `NEEDS_REPREPARE`. Abandon an unsigned managed operation to release its reservations, then prepare again with the required terms. Paid Credit revocation also requires a positive fee during prepare to validate the deployed fee token. A permit covering the prepared gross funding can be reused for that amount. Supply `fundingPermit` when the final gross changes.

The seventh EIP-712 quote field is `execution` (`direct` or `aggregate`), after `requestHash`; it is required and verified. Cold-period quotes may choose direct execution. After attaching the wallet signature to the quoted operation, call `authorized.prove()` without manually selecting a route. Aggregate quotes accept unfunded private C1..C10 transfers only. The SDK submits canonical public member data plus `memberProof`; it never exports those bytes as a directly sendable transaction or uploads private openings. The Broadcaster owns batching and one-member fallback, while charging according to its direct-based quote.

`queued` and `proving` are accepted service jobs, not chain confirmation. Save the opaque submission ID and poll `client.status(id)`. Known IDs are queried without resending, including when lookup fails. An ID-less lost response retries the exact frozen data, member proof and Source evidence. Session persists that envelope before network submission and retains input reservations until canonical primary-chain reconciliation; service `rejected` or `expired` alone cannot release them.

Discovery reads registered credentials from Protocol RPC and checks token capability only; it does not estimate gas or fees. Exact shape acceptance and pricing belong to the concrete quote. Client construction requires no Source policy switch; first submission reads service requirements and the server enforces Source acceptance.

The independent Provenance feature keeps source recognition separate from protocol spendability. Relay use is optional and restricted to each operator's supported tokens. For a relay quote requiring Source on a private input, `prove()` returns a proved handle. Attach any required funding signature, then call `await handle.ready()` to generate and persist the Source evidence. A failed Source finalization can retry using the same main proof. Repeated ready calls reuse the finalized evidence. First submit consumes those artifacts and checks current broadcaster requirements. Direct protocol submission and source submission are independent App-controlled steps, in either order. Successful private-input preflight returns a durable tracking ID; default recovery persists it before broadcast permission and uses automatic chain matching, with bounded tracking waits and primary reconciliation. Normal confirmation does not require another `submitProof`. Explicit `prepareDirect` / `PrepareDirect` / `prepare_direct` and manual submission remain available for an intentionally selected self-broadcast/reproof fallback; missing tracking never silently switches modes. App integration, raw openings, signing and nonce reservations remain host-owned. See the flat [Provenance examples](examples/07-broadcaster/).

The dependency order is `primitives → protocol`, then independent `prover` and `rpc`, then stateless `sdk`, then managed `session`. Session also uses public protocol DTOs directly. React/Vue depend on SDK/session only. `pnpm check:boundaries` enforces this DAG and rejects network execution or proof runtimes in pure modules. Long-term protocol and Provenance design lives in the [protocol documentation](https://github.com/invisi-labs/protocol-docs).

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

## Optional atomic swap payments

The canonical Router/account and relay APIs described here are included in SDK 1.3.3.

`@invisi-labs/payment-router` composes the stateless SDK with the canonical `invisi-periphery` PaymentRouter and constrained PaymentRouterAccount. Dependency direction is payment-router -> sdk/protocol/primitives. The four modes are `DirectNative`, `DirectToken`, `RelayedToken` and `SponsoredNative`. The host supplies trusted deployment addresses, wallet signing, approval, balances, proof execution and submission.

`preparePayment` binds the Router as Core funding payer, uses explicit Note outputs (currently at least two), and consumes no private inputs. Exact Core funding equals the output sum **plus the Core token fee**. Native (`tokenIn: ZeroAddress`) or arbitrary supported ERC20 input can use `UniswapV3Adapter` or `ZeroExAdapter`; ERC20 0x routes use the configured AllowanceHolder/current Settler. Omit the swap quote for same-token input or native-to-WETH wrapping. Opaque 0x liquidity actions still require full simulation; an API transport does not guarantee a compatible exact-output quote.

For relaying, prepare the Core transaction and exact-output route without proving, then call `prepareRouterPaymentDraft` and `buildRouterPaymentDraft`. Use `estimateRouterPaymentGas` with the existing Core gas preview, call `PaymentRouterRelayClient.estimateRouterFee`, and rebuild the unsigned final Core fee and route if needed. Keep the final approved fee at or above the estimate and within the user's fee/input caps. Obtain `getQuote` on that final draft **before proof execution and wallet signing**. After proving, `finalizeRouterPayment` retains the quoted Core business fields and rebuilds the actual proof-dependent signing hash; sign the final call and simulate it with `simulateRouterPayment` before explicit submission. Direct modes use the payer wallet and require no relay quote.

ERC20 payers approve the **Router** with `inputApproval`/`inputAllowance` or attach a supported ERC-2612 permit; set its deadline before quoting and add its signature afterwards. Relayed ERC20 also requires `signPaymentIntent`. Sponsored native uses `prepareNativeAccountPayment`, `buildAccountPaymentDraft` and unsigned EIP-7702 metadata when delegation is needed. Quote first, then prove and rebuild the account's Router call before `signNativePayment` and the delegation signature. Its outer value is zero; the payer account supplies native principal. Router, account action, payer EOA authorization and Broadcaster sending nonces have distinct roles. Revocation/reinstallation does not reset action storage, foreign delegation is never replaced automatically, and delegation can persist after a reverted payment.

The local `payment-router-gas-v1` preview has `source: "model"`: conservative engineering allowances on the Core baseline, not measured swap benchmarks. An opaque 0x route without a trusted independent gas budget returns unavailable; the service uses its own operator route budget and ignores client gas hints. Broadcaster Router fees use live network gas pricing within configured caps and settle only through the Core output-token fee ledger. Estimate/quote accept unproved unsigned drafts and validate business fields plus live deployment/nonce metadata. The service performs full actual-call RPC estimation/simulation and validates actual proof/hash/signatures on submission, within signed gas/token fee caps.

`PaymentRouterRelayClient` carries embedded Core `data` and the `router` envelope through standard Broadcaster estimate/quote/submit methods. The ordinary Core `BroadcasterClient` verifies a different hash. New direct-only quotes use `payment-router-intent-v1`: proof bytes and wallet signature limbs are excluded, while every business field, ordered delegation chain/address/nonce metadata and outer target remain bound. A quote verifies on both the unsigned draft and proved/signed final call. `hashRelayEnvelope` and `payment-router-envelope-v1` remain explicit legacy compatibility utilities. Router aggregation and scheduling are rejected.

Persist the final envelope and signed quote before explicit submission. An accepted semantic intent returns its existing opaque server ID even if proof/signature bytes differ; changing a fee, route, payer, budget, nonce, deadline, delivery or delegation metadata requires a new quote. Poll `broadcaster_getTransactionStatus` with that ID; if acknowledgement is lost, recover the frozen request without automatic rebroadcast. See the [package guide](packages/payment-router/README.md) and [canonical host integration examples](examples/08-payment-router/03-canonical-host.ts). Existing `01-uniswap-v3.ts` / `02-zeroex.ts` use the **legacy native-only** `buildPaymentTransaction` / `simulatePayment` APIs. API keys belong on a backend. Private-input swaps, cross-chain settlement, Permit2 and asynchronous orders remain outside this extension.

Compiled-contract integration is optional and runs on a fresh local Anvil using the sibling Router project's built artifacts:

```sh
INVISI_PERIPHERY_REPO=/absolute/path/to/invisi-periphery pnpm --filter @invisi-labs/payment-router exec vitest run src/contracts.integration.test.ts --maxWorkers=1 --minWorkers=1
```

Supply an absolute repository path when running from a package directory. The tests exercise real Router/native/ERC20 settlement with external liquidity and proof-verification boundary doubles; they do not claim genuine ZK proving or live API routing.

## Independent proving resource sets

Core (Transact/Credit, including initial-payment) and Provenance use separate immutable catalogs. The default Core index is `36f58bac1a0f70c6f8422b47f7cc35a30416a20f8a0f30038d23db0832e2bc93`; the Provenance index is `8d5a3e60e3e5cbe315150511207d7aff67f4e2924148d396b67d82017ecd1f1c`. Public objects retain their existing bytes and logical names. Downloads use `/prover/sets/<index-hash>/`, and verified objects share the same content-addressed cache.

Core operations do not require the Provenance catalog; Provenance operations do not load Core. Missing or corrupt split resources fail without a legacy downgrade. Historical catalogs remain available through explicit legacy configuration.

**Release prerequisite:** these split catalogs have been built and verified locally but are not claimed published. Publish each producer's authenticated CI artifact before releasing SDKs with these new defaults. Until then, provision matching local catalogs or select legacy mode explicitly. No production pins are fetched from an untrusted URL or inferred from a failed download.

Native and WASM resource options accept `release: "legacy"`. Native `directory`/`baseUrls` configure Core; `provenanceDirectory`/`provenanceBaseUrls` configure Provenance. Browser options use the two URL lists and share their cache. In legacy mode, an unspecified Provenance URL inherits the combined source.


### Broadcaster preparation fee locks

High-level ordinary Core and Credit quotation discovers the broadcaster fee-lock capability. A supporting service signs a short-lived tariff before fee preparation; every estimate and the final quote use that same tariff. Fee-induced input/change/funding/Permit changes still affect gas, while market price refreshes do not invalidate preparation. The fee stays within the caller's existing maximum. Fees and final quotes are frozen before authorization and proving.

Services without the advertised capability keep the legacy quotation flow. An advertised but invalid, expired or unavailable lock fails explicitly instead of silently switching to live pricing. Locks apply to Core quotation, including supported scheduling/aggregation; Router quotation is unchanged. The final quote and persisted submission/recovery formats are unchanged, and a lock never extends transaction authorization deadlines or Credit usage periods. Preparing a quote is atomic: only the final quote needs to survive a successful preparation; a failed preparation acquires a new ticket on retry.
