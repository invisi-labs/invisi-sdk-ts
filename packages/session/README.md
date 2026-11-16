# @invisi-labs/session

Managed wallet state for browsers, merchants and services. The package depends on the stateless `@invisi-labs/sdk` and adds inventory, selection, reservations, history, canonical updates and recoverable operations.

```ts
import { Invisi, Wallet } from "@invisi-labs/sdk";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";

const invisi = new Invisi({ provider, protocolRpc, prover });
const wallet = Wallet.fromAddress(receivingAddress);
const session = await WalletSession.connect({
    invisi,
    wallet,
    protocol,
    store: new MemoryWalletStore(),
});
const pending = await session.refresh({ onProgress: console.log });
await pending.decrypt(decryptor); // App-supplied DeliveryDecryptor
const balance = await session.balance(tokenAddress);
```

Memory storage is explicitly ephemeral. Persistent hosts import `@invisi-labs/session/indexeddb` or `@invisi-labs/session/sqlite` and supply an `EncryptedWalletCodec` with their own encryption key and database connection. Adapters do not choose keys or open an application database implicitly.

`new WalletSession(...)` constructs a lazy handle. Its asynchronous methods validate the configured deployment, using an authenticated preparation snapshot when available and live infrastructure otherwise. `WalletSession.connect(...)` performs the same validation immediately; a retained snapshot permits offline reopening. Both accept shared infrastructure through `invisi`; the session alone receives store, namespace, signer, fundingSigner and coinSelector capabilities.

`Operation` owns persisted lifecycle and recovery. `PreparedTransaction` remains in `@invisi-labs/sdk` for callers that supply notes explicitly and own their state. Either can export calldata for an external ethers signer. Session sending is a thin delegation to its optional ethers signer.

The SDK keeps ordinary Note inventory and deferred Credit states separate. Credit creation/update charge only an optional owner-wallet fee; draw receipts and usage are gross, while the ordinary recipient Note receives gross minus fee. Public revocation uses its grant reference and owner EIP712/ERC1271 authorization without a prover.


Private Noir wallet authorization signatures and witnesses are not persisted. Public funding/revocation signatures embedded in final calldata may remain in the encrypted operation journal so recovery can reconcile the exact request; this public authorization material is a separate persistence boundary.

Session owns no wallet transport. Native detection and authenticated decryption are explicitly injected. Detection receives a batch containing owner, chain, protocol, token, output commitment, role, clue and ciphertext. Its response echoes the owner and returns one `candidate`, `not-recipient` or `unresolved` result per item. Detection private keys remain in the App. Decryption receives the same context (ciphertext is its first argument) and returns authenticated plaintext bytes, explicit `null` for a known nonrecipient, or `{ status: "authentication-failed" }` when AEAD cannot distinguish a wrong key from damaged ciphertext. SDK validation binds plaintext to owner, token, deployment, commitment and Credit receiving keys.

Ambiguous candidates are persisted in the encrypted account store and retried with `session.retryUnresolved(decryptor)`. Scanning continues, but `session.getScanStatus().assetCompleteness` remains `unknown` and available balances are unknown. Locked wallets, cancellation, expired sessions, wrong accounts and invalid authenticated plaintext reject the batch. A failed batch does not advance its account cursor; earlier committed batches remain. The App must not translate generic exceptions into nonrecipient results. No unlocking, private key storage or App bridge lives in the SDK.

### Shared public history

Reuse the existing atomic Store adapters for a deployment-wide public cache and separate account records. SQLite uses a separate `invisi_public_history` table in the host-owned database; IndexedDB uses a separate database. Neither needs an account key. The encrypted `WalletStore` still owns each account's inventory, unresolved candidates, reservations and operations.

```ts
import { PublicHistory, WalletSession } from "@invisi-labs/session";
import { SQLitePublicHistoryStore, SQLiteWalletStore } from "@invisi-labs/session/sqlite";

const history = new PublicHistory({
    store: new SQLitePublicHistoryStore(database),
    protocol,
    reader: chainReader,
    protocolRpc,
});
const store = new SQLiteWalletStore(database, accountCodec);
const a = new WalletSession({ invisi, protocol, wallet: walletA, store, publicHistory: history });
const b = new WalletSession({ invisi, protocol, wallet: walletB, store, publicHistory: history });

await a.synchronizeHistory({ onProgress: console.log }); // No account keys or decryption.
await a.scanHistory(decryptorA, { onProgress: console.log });
await b.scanHistory(decryptorB, { offline: true }); // Same public pages; independent account cursor.
console.log(await b.getScanStatus());
await b.refreshState(); // Known nullifiers, Credit revocation and in-flight operations, without decryption.
```

A shared encrypted Store/codec can isolate accounts by scope; hosts using different encryption keys can inject separate private Stores while sharing the same `PublicHistory`. Public cache keys bind chain, protocol address, runtime code hash and deployment block. Account keys additionally bind namespace and owner.

| Entry point | Responsibility |
| --- | --- |
| `synchronizeHistory({ fromBlock?, toBlock?, pageSize?, signal?, onProgress? })` | Fetch/verify/commit public headers, successful receipts, parsed deliveries and position validation, including empty ranges. |
| `scanHistory(decryptor, { offline?, reset?, fromBlock?, toBlock?, signal?, onProgress? })` | Read retained public pages and atomically commit each private batch with its independent contiguous cursor. |
| `refreshState()` | Refresh known assets and in-flight operations at the known primary-chain head; does not claim unscanned history was processed. |
| `retryUnresolved(decryptor)` | Retry retained ambiguous candidates without moving discovery coverage. |
| `getScanStatus()` | Public/account committed checkpoints, unresolved count and asset completeness relative to the public checkpoint. |
| `refresh(range).then(pending => pending.decrypt(decryptor))` | Convenient public synchronization followed by the same per-batch private scan. |

Public pages default to 100 blocks, maximum 256; extremely dense pages or pages exceeding the byte budget require a smaller range. Pages, rather than an entire historical scan, are held in memory. Progress distinguishes processing from committed checkpoints. Account cursors advance only across contiguous covered ranges, including empty ones. An empty range skips decryption but still refreshes known state unless offline or explicitly disabled. Offline scans never refresh spent status; newly recovered assets remain unknown until online refresh.

Sessions sharing one `PublicHistoryStore` instance serialize public tasks and reuse completed overlapping ranges. Cancelling one subscriber stops its wait, not the download another subscriber needs. Share the instance per deployment; independently opened processes/tabs use storage CAS for consistency but do not coalesce network requests. Without an injected persistent cache, sessions sharing the same `Invisi` receive an ephemeral shared cache.

Synchronization checks canonical anchors. On a fork, public generation changes, orphan coverage is removed, and each account is fenced on its next read/scan. Rebuild with `scanHistory(decryptor, { reset: true })`; uncertain/externalized operations remain available for reconciliation. The reset must start at the deployment block for a complete rebuild. `history.pruneBefore(block)` evicts whole old pages while retaining the historical public checkpoint: offline rescanning evicted ranges fails explicitly. Re-download them with `synchronizeHistory({ fromBlock, toBlock })` before scanning or retrying. Missing/corrupt cached page data is re-fetched by explicit synchronization of that range.

The cache trusts the host storage's integrity; its digest detects accidental corruption, not a malicious host rewriting both metadata and pages. Verification follows the existing trust model: Chain RPC authenticates receipts and block identities, while Protocol RPC supplies candidate discovery. This is not a cryptographic proof that the indexer omitted no transactions. Cached receipt parsing and delivery position checks are reused across accounts; Credit recovery can still request membership for newly reconstructed states absent from public deliveries.

Authorization uses `operation.exportWalletAuthorization()`, ethers `signTypedData()` and `operation.withWalletSignature(signature)`. Native request/response envelopes are unnecessary.

The App decryptor must authenticate the ciphertext (including the AEAD tag) before returning plaintext. Commitment checks validate financial contents; they do not independently authenticate opaque memo bytes.

### Managed Credit examples

See [the Credit walkthrough](../../examples/README.md#managed-credit-walkthrough) for four flat SQLite-backed Session mains: create, batch draw across different payers, update remaining quota, and proofless owner revocation. All use the same public Wallet and explicitly injected App decryptor as Note payments. Example 4 recovers both Note and Credit operations with the original account and encrypted store. Credit authority and reservations stay separate from ordinary Note balances; successful draws issue ordinary recipient Notes.

### Long-running histories

The public cache defaults to **128 MiB of retained page payloads, 4,096 page references and 8 MiB per page**. The directory therefore stays bounded as the chain ages. Eviction removes the lowest block ranges first, preserving the newest chain data. Historical backfills that fall outside the retained window are handed directly to the active scan as one bounded page; they do not displace newer cached ranges. These are application-configurable limits, not a guarantee of total process RSS or database file size. SQLite can reuse deleted space without shrinking its file; the host owns database maintenance.

```ts
const publicStore = new SQLitePublicHistoryStore(database, {
    retention: { maxBytes: 128 * 1024 * 1024, maxPages: 4096, maxPageBytes: 8 * 1024 * 1024 },
});
const privateStore = new SQLiteWalletStore(database, accountCodec, { recentRecords: 128 });
```

`refresh()` stages the first bounded recent page and returns the independently checked target block. `fromBlock` is an optional lower recovery bound (default deployment), and `toBlock` fixes this run's indexed target. `pending.decrypt(decryptor)` then interleaves missing-page downloads, account scanning and batch commits. It does not download an entire old chain only to evict it before scanning. Online `scanHistory` re-fetches missing ranges; offline scans fail explicitly when retained coverage is missing. A separate `synchronizeHistory` call can still prefetch a range, but data beyond the cache budget is evicted normally.

The built-in Memory, SQLite and IndexedDB wallet adapters use encrypted per-record rows plus small encrypted checkpoint metadata. Only changed rows, encrypted locators and metadata are written, atomically under the account revision. Active row counts and ciphertext digests bind the inventory to that metadata: missing or replayed rows fail instead of appearing as an empty wallet. Existing single-blob wallet data migrates on the next successful write; a failed migration leaves the previous blob intact. Custom codecs must losslessly preserve storage metadata; the SDK checks the round trip before publishing changed rows or checkpoints. Custom atomic adapters retain their blob layout until they implement `readPage` and `compareAndSwapBatch`; paging APIs fail explicitly if those capabilities are absent. An already migrated wallet cannot be opened through a blob-only adapter.

Ordinary account snapshots contain active inventory and the latest **128 terminal records per collection** by default. Older spent Note/Credit records and completed operations move to encrypted archive rows. Reserved assets and their operation journals, unresolved candidates, nonterminal operations and potentially broadcast failed/expired operations stay active. Archive rows are not deleted. This bounds the impact of completed history; live assets, unresolved candidates and pending operations can still grow and must not be silently discarded.

Use bounded history queries in App/Web screens:

```ts
const page = await session.getHistoryPage({ direction: "incoming", limit: 50 });
console.log(page.items); // entry, archived, canonical
if (page.nextCursor) {
    console.log(await session.getHistoryPage({ direction: "incoming", limit: 50, cursor: page.nextCursor }));
}
```

`direction: "outgoing"` pages operation history. Optional token filtering applies to the selected page; a filtered page can be empty and still have a continuation cursor. Cursors bind account, record kind and revision; if the wallet changes, restart pagination instead of silently skipping or duplicating entries. `getHistory()` remains an explicit full-history compatibility view and can allocate the entire result; use `getHistoryPage()` for normal screens. `getScanStatus()` reads small metadata without loading inventory.

Raw store users can call `readRecords(scope, { kind, limit, cursor })` for Notes, Credits, operations, reservations or unresolved candidates. Rows use an encrypted per-wallet index secret and discovery sequence, rather than public commitments or block heights, for routing. Pages follow discovery order (newly discovered first); the full compatibility view sorts by chain height. Routing still reveals row counts, categories and storage order to the database host.

Old archived rows become `canonical: "unknown"` after public history generation changes; archiving never declares chain finality. Before rebuilding balances after a fork, affected externalized operation journals are restored in bounded batches and their input reservations are reinstated. The wallet stays invalidated until this restoration completes. The SDK does not automatically delete private history, unresolved candidates or in-flight records. Account database lifecycle, export and deliberate deletion belong to the host.


Capacity illustration (current tagged storage encoding, 100 blocks/page, fixed-vector single-output Shield with its Note ciphertext and FMD clue; simulated receipts, not measured network traffic). The 128 MiB budget applies per chain/protocol deployment and excludes the private wallet database and page-directory overhead.

| Shield transactions per 100-block page | Encoded page bytes | Approximate retained blocks | Approximate retained transactions |
| --- | ---: | ---: | ---: |
| 0 | 26,521 | 409,600 | 0 |
| 1 | 31,224 | 409,600 | 4,096 |
| 10 | 73,578 | 182,400 | 18,240 |
| 100 | 497,388 | 26,900 | 26,900 |
| 1,000 | 4,738,188 | 2,800 | 28,000 |

Each transaction adds approximately 4.6 KiB in this fixture. Multi-output transactions, payloads and batch Credit operations differ; these counts are illustrative, not guaranteed capacity. Whole-page eviction and the page-count ceiling also constrain retention.


### Prioritized recovery and wallet status

An existing cached window is extended from its high end to the current indexed head before older gaps are scanned backwards towards deployment. An empty cache starts with a bounded recent page. Public validated coverage and per-account scanned coverage are persisted separately from retained pages, so cache eviction and restart do not erase completed coverage or falsely fill gaps. Explicit `synchronizeHistory({ fromBlock, toBlock })` remains a forward range request; omit `fromBlock` for prioritized public recovery.

Newly discovered Notes are checked for consumption against the known primary-chain head, even if the indexing service is behind it. Historical recovery therefore does not temporarily expose old spent Notes as usable. Credit successors have causal dependencies: private parents remain available while a bounded chronological Credit-only pass repairs successor states. That pass has its own persisted cursor, required target and revision; cancellation or an older snapshot request cannot discard remaining work. Retrying an unresolved Credit parent also schedules its successor recovery. Offline scans keep this work pending rather than claiming it completed.

```ts
const pending = await session.refresh({
    onProgress: (progress) => console.log(progress.phase, progress.direction, progress.target),
});
await pending.decrypt(decryptor);
console.log(await session.getScanStatus());
console.log(await session.getFundsStatus(tokenAddress));
```

| Fact / interface | Meaning |
| --- | --- |
| `recoveryStartHeight` | Protocol deployment height; no inference from the first transaction. |
| `chainHeight` / `indexedHeight` | Last observed primary-chain tip and independently checked indexer tip; unavailable data stays null. |
| `maxScannedHeight` | Highest account-scanned block; gaps below it are allowed. |
| `fullyScannedHeight` | Contiguous account scan coverage starting at deployment. |
| `unscannedRanges` / `suggestedScanRanges` | Remaining intervals and recommended head-first/backward scheduling. |
| `recoveryBoundary` | Persisted split between recent catch-up and older recovery; not the first payment height. |
| `progress.recent` / `progress.recovery` | Completed/total block counts with an explicitly block-based ratio; empty intervals have ratio null and complete true. These are not Note-weighted work or proving-time estimates. |
| `scanComplete` | Contiguous canonical account discovery reaches the known chain tip. |
| `isSynced` | `scanComplete` plus completion of causal Credit recovery. Unresolved authentication candidates are reported independently. |
| `assetCompleteness` / `unresolvedCount` | Whether unresolved authentication ambiguity still prevents claiming a complete inventory. |
| `getFundsStatus(token).areFundsSpendable` | At least one known, unreserved Note has a verified unspent observation matching the known head. Independent of historical completeness. |

For example, scanning 100–300 and 900–1,000 yields max height 1,000, fully scanned height 300 and a missing interval 301–899. A known unspent Note from 950 can still fund a payment; `isSynced` remains false. Reserved, stale, unknown or invalidated inputs are excluded from spendable funds. Preparation still independently validates membership, consumption, fees and authorization; the status is not a promise that a future transaction succeeds.

Use `onProgress` for processing/committed page events and directions (`forward`, `backward`, `credit-recovery`); use `session.subscribe` for local wallet commits and re-read the status/funds interfaces. The host owns foreground/background scheduling, cancellation and UI text. Each call has a fixed target snapshot; a host can cancel historical recovery at a committed batch and start a new catch-up without losing completed ranges. If the indexer lags the known network tip, status requests an indexer wait instead of declaring full sync.

The API distinction follows the ideas in [Zcash WalletRead](https://zcash.github.io/librustzcash/rustdoc/latest/zcash_client_backend/data_api/trait.WalletRead.html) and [Android Synchronizer](https://github.com/zcash/zcash-android-wallet-sdk/blob/main/sdk-lib/src/main/java/cash/z/ecc/android/sdk/Synchronizer.kt); the counters here describe Invisi block coverage and Credit recovery.

## Local gas estimation

Call `operation.estimateGas()` immediately after preparation, before signing, proving or approval. This read-only local calculation uses transaction structure and benchmark medians; it needs no RPC or provider and does not export or externalize the operation.

```ts
const operation = await session.prepareTransfer({ tokenAddress, outputs });
const estimate = operation.estimateGas();
if (estimate.available) console.log(estimate.gasUnits, estimate.conditions);
else console.log(estimate.reason);
```

Measurement version/hash metadata is provenance only. Unsupported shapes return `available:false` and `reason:"shape-not-covered"` with no gas count. Estimates are approximate, not guaranteed gas limits or monetary fees; the App owns live fee pricing, approval, final simulation and safety margins. Sending through `session.sendTransaction` requires a positive `gasLimit` supplied by the host, preventing implicit ethers estimation.

Preparation and signing performance: read-only signing freshness checks no longer commit a wallet revision. Store instances keep a bounded decoded-record LRU (512 entries, 8 MiB of ciphertext-weighted data), keyed by storage key, revision and SHA-256 of the ciphertext. Backend revision/integrity checks and CAS writes remain authoritative; modified or failed ciphertext is never accepted from an older cache entry. Every returned state is independently cloned. The cache is never persisted. Scope a store instance to its unlocked wallet lifetime and discard it on lock/logout; keep host lifecycle/permission guards in place. Optional short-lived public-read reuse during quotation is automatic and does not change the preparation API.


### Cached and offline preparation

Online `refresh().decrypt(...)`, `scanHistory(...)` and `refreshState()` retain a canonically verified preparation snapshot with encrypted wallet metadata. It includes known unspent Note/Credit authentication paths, pinned roots, deployment/token code, observed consumption/revocation state, the account funding nonce and Credit allocation. Capture is fenced against concurrent inventory changes and public-history generations. Normal sync authentication paths and exact-anchor consumption/revocation reads are reused rather than fetched again. Later refreshes retain immutable paths only while their roots remain accepted at the new canonical anchor; expired roots trigger fresh authenticated paths. Transient public capture is bounded and never added to public-history storage; encrypted snapshots contain only the account’s selected unspent inventory. Offline scans do not create fresh observations. Existing call signatures stay unchanged; there is no separate preparation synchronization API.

`prepareTransfer`, `prepareShield` and all four Credit preparations automatically reuse retained facts. With complete input data and full receiving addresses (or already resolved outputs), preparation, EOA authorization, local proving and calldata export work without network reads. Proof artifacts/CRS must already be available. Retain or configure the trusted deployment profile before reopening offline; `Protocol.fromRpc(...)` itself remains an online lookup. A missing cached fact automatically falls back to live preparation, so first-use tokens remain usable online. Unknown tokens, uncached external funding nonces, short-address lookups and contract-wallet authorization may still require online data. An explicit external `funding.sigNonce` can freeze the nonce supplied by the host.

`operation.preview().submissionValidation === "required"` means the message was built from historical facts. The default deadline uses the later of the local construction time and cached block time, while `preparedAt` retains the genuine canonical anchor. Credit draw periods use construction time and are rechecked before sending. A changed history generation or observation cannot silently reuse an older snapshot.

`operation.exportTransaction()` can export this cached message offline; it does not certify that it can execute now. `session.sendTransaction(operation)` and Broadcaster submission automatically run the live gate. A host sending exported calldata directly with ethers must call `await operation.validateSubmission()` immediately before sending. The gate checks current deployment, expiry/period, funding nonce and signature, accepted roots, input consumption, Credit revocation/allocation, and token balance/allowance, then fences canonical blocks. Custom `ChainReader` implementations need `getTokenBalanceAllowance` for cached operations that debit public tokens; `EthersChainReader` supplies it. An ERC20 Permit may establish allowance during execution; balance is still checked. A rejected root or changed frozen statement may require new authorization and proof.

```ts
await (await session.refresh()).decrypt(decryptor); // Online: retains verified preparation facts.
const operation = await session.prepareTransfer({ tokenAddress, outputs }); // Local when covered.
const request = await operation.exportWalletAuthorization();
const signature = await signer.signTypedData(request.domain, request.types, request.message);
const ready = await (await operation.withWalletSignature(signature)).prove();
const call = await ready.exportTransaction(); // May run offline.
// Once online: send the operation to enforce live checks, or validate before a direct ethers send.
await session.sendTransaction(ready, { gasLimit });
```

### Explicit note collection

`await session.importNotes(inputs)` accepts the SDK's `NoteInput[]` openings. Import validates owner/deployment, amount, recomputed commitment, authenticated membership and current nullifiers, then commits with a revision fence. Reimport preserves spent state and operation reservations. It updates the known-state observation without advancing discovery coverage; imported notes do not establish that all wallet funds were discovered.

```ts
await session.importNotes([{ note, commitment, treeId, leafIndex }]);
const collection = await session.prepareCollection({
    tokenAddress,
    recipient,
    commitments: [commitment],
    // deadline: optional Unix seconds as bigint
});
const quoted = await broadcaster.quote(collection, {
    feeSource: "payout",
    maxFeeAmount: 1000n,
});
```

`CollectionPreparation` is exported from `@invisi-labs/session`. Collection reserves exactly the selected available notes and withdraws their entire sum, with no funding or private outputs. Payout fees are available only for a pure unfunded full withdrawal. Quotation deducts the fee from that frozen gross sum, requires a positive net withdrawal and owner authorization, and honors the caller's maximum fee. Requoting replaces the fee immutably; it never deducts it twice or adds notes. Authorize and prove the quoted operation through the normal operation lifecycle.

## Contributing

See the [contribution guidelines](../../README.md#contributing) for issues, pull requests, validation, and handling sensitive material.
