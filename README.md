# Invisi TypeScript SDK

A capability SDK for browser wallets, merchant applications, proof services, aggregators and relayers. Stateless objects compose through `Invisi`; managed wallets add `WalletSession` from `@invisi-labs/session`. applications explicitly choose permissions, infrastructure and runtime backends.

```ts
import { Invisi, Wallet, NoteOutput, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { WalletSession } from "@invisi-labs/session";
import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";

const provider = new JsonRpcProvider(chainRpcUrl);
const signer = new EthereumWallet(evmPrivateKey, provider);
const wallet = await Wallet.fromPrivateKey(evmPrivateKey);
const protocolRpc = new ProtocolRpcClient(protocolRpcUrl);
const protocol = await Protocol.fromRpc(protocolRpc, provider);
const invisi = new Invisi({ provider, protocolRpc, prover });
const session = await WalletSession.connect({ invisi, wallet, protocol, store, signer });

await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });
const prepared = await session.prepareTransfer({
    tokenAddress,
    outputs: [await NoteOutput.create({
        chainId: protocol.context.chainId,
        protocolAddress: protocol.context.protocolAddress,
        tokenAddress,
        amount: 30n,
        recipient: { type: "invisi", address: recipientAddress },
    })],
});
// Review prepared.preview() locally before private authorization.
const authorized = await prepared.authorize();
const ready = await authorized.prove();
const transaction = await session.sendTransaction(ready);
await transaction.wait();
const tracked = await session.resume(ready.id);
await tracked.reconcile();
```

Deployment records pin a trusted multi-token Protocol, its runtime hash and scan start block. `WalletSession.connect({ invisi, wallet, protocol })` validates that deployment; each operation selects `tokenAddress`. ERC20 assets require no registration. Protocol and circuit pauses, address screening, and funding/spend authorization control settlement. Exact-receipt checks reject fee-on-transfer deposits; rebasing assets are not supported. Teams deploy independent Protocols and publish their deployment through their own Protocol RPC. `Protocol.fromRpc(rpc, provider)` loads and pins the service record asynchronously. `new Protocol({ deployment })` accepts an explicitly supplied record synchronously. Select a trusted service, or pass an independently published record as `ProtocolRpcClient({ deployment, ... })` to pin the expected deployment. Chain validation checks consistency, not whether a deployment is official. Deployment schemas and parsing belong to `@invisi-labs/rpc`; the SDK keeps no deployment catalog. The Protocol repository's `deployment/deployment.json` includes the reproducible Anvil deployment; Protocol RPC reads that catalog. See [local deployment and custom records](examples/README.md#local-deployment). Indexed history and wallet state are scoped to the deployment; balances and coin selection remain asset-specific. `protocol.forToken(tokenAddress)` supplies low-level builders, while `protocol.aggregate(...)` supports mixed-token requests.

`Invisi` owns shared infrastructure: Chain RPC, Protocol RPC, store, prover and protocol authorization. `connect()` selects `wallet`, `protocol`, optional `namespace`, optional `viewing` or `authorization` overrides, and explicit session-only `signer` / `fundingSigner` capabilities. A complete wallet supplies these permissions automatically. Membership paths come from Protocol RPC; note nullifiers and public receiving keys are derived from the selected wallet. No separate `membership`, `nullifier`, `detector` or `receivingAddress` session options are needed. FMD delegation remains explicit on `refresh({ detectionKey })`.

This transfer spends private notes. Explicit public funding adds an EVM funding grant after the actual proof exists. Private authorization uses the original selected EVM account key in a separate signing domain; a funding signature or transaction sender cannot substitute for it. Funding and gas may use a separate account. Constructors neither start background tasks nor silently create storage, RPC clients or proving processes.

## Application-owned data without a Store

`@invisi-labs/session` provides `WalletSession`, which manages inventory, selection, reservations and operation recovery. It depends on the stateless `@invisi-labs/sdk`; the SDK never imports the session package. Store adapters are explicit imports from `@invisi-labs/session/memory`, `/indexeddb`, or `/sqlite`, with `EncryptedWalletCodec` available from the session root. Store, viewing, signing and selection capabilities belong to the session configuration. `new WalletSession({ invisi, wallet, protocol, store })` creates a handle without network access; asynchronous operations validate the deployment before using wallet state. `await WalletSession.connect(...)` performs that validation before returning the handle. Both use the same session implementation. `Invisi` takes shared infrastructure only. Applications that own their database can instead call `Invisi.prepareTransfer`, `prepareShield`, `prepareCreateCredit`, `prepareDrawCredit`, `prepareTopUpCredit` and `prepareCancelCredit` directly. These methods never read or write a WalletStore and do not create a hidden memory store. The managed and explicit paths share preparation, statement, witness, authorization, proof-verification and calldata logic.

```ts
const invisi = new Invisi({ provider, protocolRpc, prover });
const prepared = await invisi.prepareTransfer({
    wallet: PublicWallet.fromAddress(receivingAddress),
    protocol,
    tokenAddress,
    inputs: applicationSelectedNotes,
    outputs: [await NoteOutput.create({
        chainId: protocol.context.chainId,
        protocolAddress: protocol.context.protocolAddress,
        tokenAddress,
        amount: 30n,
        recipient: { type: "invisi", address: recipientAddress },
    })],
});

// Review privately before granting authorization.
const review = prepared.preview();
const request = await prepared.exportWalletAuthorization();
const signature = await ownerSigner.signTypedData(request.domain, request.types, request.message);
const authorized = await prepared.withWalletSignature(signature);
const ready = await authorized.prove({ onProgress });
const call = await ready.exportTransaction();
const transaction = await signer.sendTransaction(call);
```

Each funds `NoteInput` contains `{ note, commitment, treeId, leafIndex }`. Explicit funds operations consume all supplied inputs; they do not silently select a smaller subset or call an application coin selector. Choose a subset by supplying only the selected `NoteInput` records. Change defaults to the wallet's receiving address; signed operations may supply `changeAddress`. `CreditInput` contains `{ state, commitment, treeId, leafIndex, role }`; provide role-specific records through `creditInputs` and select the credits to use with the normal Credit operation options. Owner and spender inputs remain subject to their actual leaf-bound permissions.

The SDK validates note preimages, wallet identity, deployment/token scope, canonical membership, spent state and the frozen proof statement. Supplying a record does not make it trusted. Chain RPC and Protocol RPC remain infrastructure dependencies; a Store adapter does not.

`PreparedTransaction` is a local immutable operation handle. It supports `preview`, request export and signature attachment, `prove`, caller-funded shield `ready`, `exportTransaction`, `exportProof` and `exportAggregateMember`. Independent preparation accepts only public wallet identity and never automatically extracts private authorization. A prover may be supplied with `prove(prover, options)`. Private note authorization, cash funding and gas payment remain independent. Local signing convenience methods belong to managed Session operations.

### External signing tools

The application can keep signing on another device or service. `Invisi` accepts infrastructure only and rejects constructor `signer` / `fundingSigner` options:

```ts
const request = await prepared.exportFundingAuthorization();
// Send JSON.stringify(request) to the funding owner's signing tool.
const signature = await bobSigner.signTypedData(request.domain, request.types, request.message);
const ready = await prepared.withFundingSignature(signature);
const call = await ready.exportTransaction();
await aliceSigner.sendTransaction(call);
```

`SigningRequest` contains JSON-safe `domain`, `primaryType`, `types`, and `message`. It can make a JSON round trip without a bigint codec and is directly accepted by ethers `signTypedData`. Wallet RPC integrations add their own `EIP712Domain` transport type. The SDK recomputes its frozen request when accepting a signature; it does not trust a returned request object. Funding signatures bind the payer, exact amount, token/output/delivery request hash, deployment, nonce and deadline. Anyone may relay the unchanged authorization; it is not restricted to the example transaction sender.

- Funding: `exportFundingAuthorization()` -> external EIP-712 signature -> `withFundingSignature(signature)`. Shield needs no proof; other operations must prove first. Nonces and deadlines are rechecked after the remote round trip. ERC-1271 verification continues through the configured funding verifier.
- Private note authorization: `exportWalletAuthorization()` -> external EOA EIP-712 signature -> `withWalletSignature(signature)` -> `prove()`. Only typed commitments leave the application; the recovered public key and signature become a private circuit witness. This path supports EOA authorization, not ERC-1271 circuit signatures. Never publish the returned private-spend signature or its witness.
- Registry: `exportRegistrationAuthorization()` -> external EIP-712 signature -> `withSignature(signature)`. Existing EOA/ERC-1271 and freshness validation applies to both registration and update.

A request is bound to the original immutable handle. Attaching a signature does not reconstruct that handle after a process restart; application recovery and transport remain separate concerns. Signing tools must display trusted business context for statement/request hashes, and must support the required typed-data format. Detached `authorize`, `authorizeFunding` and registry `authorize` have been removed. Use external requests and signatures; managed Session operations retain their explicitly injected signing capabilities. Registry `authorizeDirect()` remains a caller-only construction path and does not invoke a signing tool. The `Invisi` constructor no longer accepts a default signer or funding signer; migrate those integrations to explicit request/signature boundaries and submit with ethers.

One Invisi instance may construct operations for multiple wallets by providing the wallet on every call. This does not permit mixing different owners' funds inputs in one arbitrary spend. Independent requests may be aggregated when the protocol permits it.

Applications own input reservations, concurrency across processes, persistence, broadcasting and receipt reconciliation. Detached handles provide no durable recovery or automatic balance updates; keep pending inputs reserved after exporting a proof/request until canonical consumption or genuine expiry is established. The SDK never uploads private notes to Protocol RPC. See [transfer](examples/03-hidden-amount/03-notes-to-three-with-change.ts) for explicit NoteInput construction; a private database can supply the same typed inputs.

| Component | Responsibility |
| --- | --- |
| Protocol RPC service | Public history indexing, optional candidate detection and membership path construction. |
| `@invisi-labs/rpc` | Transport, deployment/version validation and independent checks of indexed anchors and paths. |
| Chain RPC and `@invisi-labs/sdk/ethers` | Canonical blocks, receipts, contract reads, spent checks and transaction submission. |
| `@invisi-labs/core` | Wallet keys and permissions, encryption/decryption, clue creation, commitments and nullifiers. `/address` parses addresses without a proving backend. |
| `@invisi-labs/protocol` | Deployment records, protocol statements/calldata, witness builders, registry operations and generated ABIs. |
| `@invisi-labs/prover` | Local witness execution, proving and proof verification through explicit `/native`, `/wasm` and `/aggregate` entries. |
| `@invisi-labs/sdk` | Stateless transaction preparation, signing requests, proofs, calldata, output creation and infrastructure composition. |
| `@invisi-labs/session` | Managed wallet inventory, reservations, synchronization, history and operation recovery. Storage adapters use explicit `/memory`, `/sqlite` and `/indexeddb` entries. |
| `@invisi-labs/react`, `@invisi-labs/vue` | Thin operation lifecycle and cancellation wrappers. |

The SDK uses two RPC endpoints. Chain RPC supplies canonical blocks, receipts, contract reads and transaction submission. Protocol RPC indexes public history and returns candidate transaction references and membership paths. Construct `ProtocolRpcClient` explicitly and pass it to `Invisi`; membership access is injected automatically. `session.refresh({ fromBlock })` obtains candidates, independently fetches receipts through Chain RPC, decrypts locally and requests paths only for owned notes. The server cannot decrypt notes or create wallet proofs. The SDK has no local history-scanning fallback or public tree implementation.

Applications choose explicit `fromBlock` and optional `toBlock` ranges and own history pagination. Refresh also accepts `signal`, `pageSize` (1–10000 blocks per request, defaulting to the public `MAX_UPDATE_BLOCKS = 10000` constant exported by `@invisi-labs/rpc` and `@invisi-labs/sdk`) and `reset`, and returns a `RefreshResult` with the final block, added note/Credit counts and balances. Optional `detectionKey: wallet.getDetector().exportKey()` explicitly delegates detection to the detection method only; it does not delegate viewing or authorization. Candidate filtering and authenticated decryption cannot establish complete history. Credit recovery needs parent and lifecycle transactions, including draws whose new envelopes cannot be decrypted. `protocolRpc.getStatus(protocol.context)` reports `indexedHead`, `detectionEnabled` and `checkedBits`; the reported head is not a completeness proof.

WalletSession from `@invisi-labs/session` prepares shield, private transfers, full/partial withdrawals, Credit creation, spender draws, unexpired owner top-ups and owner cancellation. AddressRegistry has its own registration nonce and standard owner EIP-712 or ERC-1271 authorization; direct owner calls use an empty signature. Registration is ready after signing and requires no prover. Aggregator accepts4/8/12 current slots14 recursive public members and needs no private wallet material. Combined ordinary slots select14/56/112/168; Credit draws select1/12/50/120.

Note delivery and discovery use canonical chain events. Credit role envelopes contain both complete receiving-key snapshots, so later draw/top-up delivery does not require a business service or a fresh registry lookup. Public ERC20 settlement on Credit draw/cancel remains bound to the note's payout addresses. Business invoices, quotes, orders and negotiations belong to applications.

Receiving addresses use a 138-character `0i` full address or the owner's standard 42-character EIP-55 `0x` address as the short form. Address APIs use strings: `wallet.getAddress()`, `wallet.ownerAddress`, and `registry.resolve(ownerAddress)`. Create each recipient output with `NoteOutput.create`, then pass the resulting objects to preparation. Encrypted short-address outputs are resolved by the SDK during preparation. `PublicWallet.fromAddress` provides public receiving material. `getAddress()` requires complete receiving keys; an owner-only import exposes `ownerAddress` immediately and resolves receiving keys explicitly through the selected registry. Viewing handles decrypt and permit full funds sweeps to the same EVM owner; detection handles filter; public nullifier helpers use each note nonce to reconcile spent state; WalletAuthorization authorizes a frozen private statement. Export only the capabilities needed by the recipient. Default JSON/inspect output redacts secrets. JavaScript process memory and these variable-time, unaudited cryptographic implementations are not hardware isolation.

State is scoped by namespace, chain, protocol and wallet identity. Balance snapshots expose known funds, reservations, spent-check block/hash and the candidate observation checkpoint `observedThrough`. Unknown spent state and an unchecked empty wallet return `availableKnown:null`. Candidate updates advance `observedThrough`; they do not establish complete history. Refreshes with no incoming candidates can refresh known spent state, but cannot establish absence of incoming funds. Explicit `session.refresh({ fromBlock, reset: true })` rebuilds inventory while retaining uncertain operations and reservations; subsequent history ranges must not reset it again. Ordinary RPC supplies a trusted canonical data source; this SDK is not a consensus light client.

`Disclosure.fromNote(note)` and `Disclosure.fromCredit(note)` create commitment openings; Credit openings retain only `creditSharedKeyHash`. `wallet.getViewer().discloseNote(ciphertext, context)` and `.discloseCredit(ciphertext, context)` authenticate an existing envelope and disclose only its derived payload key. Default JSON/inspect is redacted; explicit `export()` returns sensitive versioned JSON material and `Disclosure.fromExport(material)` imports it. `getScope()` describes the exposure: complete funds openings or payload keys permit consumption tracking and owner-only full sweep; a Credit payload key unlocks the entire role envelope, including `creditSharedKey` and receiving-key snapshots. Core `verify(output)` requires independently authenticated output data. `DisclosureVerifier` resolves successful canonical receipts and matching insertion/delivery events through a trusted deployment and RPC, with explicit confirmation policy. Results establish output content/inclusion, not payer identity, source of funds, spent state or complete wallet history. See [the disclosure walkthrough](examples/06-disclosure/01-note-opening.ts) and [read-only chain verification](examples/06-disclosure/03-credit-opening.ts).

Persistent stores require caller-managed encryption keys. SQLite requires a compatible synchronous driver; the Node examples use `node:sqlite`. IndexedDB uses native CAS transactions. Memory storage is an explicit ephemeral choice. Back up the source EVM account private key, or its mnemonic/passphrase and original wallet derivation path, plus any externally rotated historical viewing keys. Invisi defines its KDF, not an HD path.

An exported or possibly broadcast proof keeps inputs reserved until canonical consumption or actual business expiry. A timeout, local abandonment, changed funding nonce, expired funding signature or currently unknown root does not revoke an exposed proof. Restore an operation by ID and reconcile it before retrying. Cancellation stops local work; it cannot revoke a transaction already sent.

[Numbered English examples](examples/README.md) show flat ethers integration, public/hidden amounts, separate signing roles, Credit, registration, aggregation, raw payloads, disclosure and durable WalletSession recovery. Customize local test accounts and connection/token/prover settings before executing on-chain examples. Applications own review, authentication, key management and commercial policies.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm lint
pnpm check:browser
pnpm check:surface
pnpm examples wallet
```

The genuine backend gate is explicit:

```sh
BB_BINARY_PATH=/absolute/path/to/bb INVISI_TEST_WASM=1 pnpm --filter @invisi-labs/prover test
```

Use BB6.0.0 and the authenticated current release assets. Independent verification and exact public statements are mandatory. Do not relabel a stale proof or use a mock verification result as circuit-soundness evidence. Browser deployment must include Noir WASM and BB module-worker assets; see the examples. Protocol ABI/circuit resources are generated by `pnpm sync:protocol` from the explicit protocol source/release.

## Protocol synchronization

Select a reviewed commit or stable Git tag in the Protocol checkout, then build and authenticate its artifacts before synchronizing. The Protocol checkout and SDK must use matching toolchain and proof versions.

```sh
pnpm sync:protocol /absolute/path/to/invisi-protocol
pnpm build
pnpm test
pnpm lint
```

Review and commit the generated ABI, circuit, verification-key and witness-layout artifacts with the matching SDK changes. Synchronization retains the pinned version and hash checks.

## Source modules

Published package names and subpath imports are stable. Inside each package, source and tests live together by capability:

| Package | Source modules |
| --- | --- |
| `core` | `wallet`, `address`, `notes`, `crypto`, `delivery`, `fmd`, `disclosure` |
| `protocol` | `client`, `funds`, `credit`, `authorization`, `registry`, `factory`, `fees`, `verification` |
| `sdk` | `client`, `protocol`, `notes`, `transactions`, `broadcaster`, `gas`, `discovery`, `disclosure` |
| `session` | `wallet`, `operations`, `sync`, `inventory`, `history`, `storage` |
| `rpc` | `client`, `deployment`, `queries`, `transport`, `validation` |
| `prover` | `backends`, `circuits`, `proofs`, `aggregation`, `witness`, `testing` |
| `react` / `vue` | Small framework entry and operation hook |

SDK transaction modules separate preparation, signing, proving and execution. Protocol witness assembly separates shared ownership/Merkle checks from each funds or Credit operation. Delivery separates envelope cryptography from note validation and payload handling. Session workers and broadcaster reservations remain in `session`; the stateless SDK has no store dependency.

Root `index.ts` files and configured subpath entries define the supported public API. Applications should import those entries rather than source directories. Generated contracts remain under `protocol/src/contracts`, and authenticated circuit assets remain under `prover/circuits`; they are updated through synchronization tools. Generated witness fixtures stay in `prover/src/testing`.

## Source formatting

Run `pnpm format` to format handwritten sources, tests, examples and scripts, or `pnpm format:check` to check them without changes. `pnpm lint` and CI include the formatting check. The pinned formatter uses four spaces, double quotes, semicolons and a preferred width of 100 columns (140 in examples to keep walkthrough messages on one line). Complex control flow should also be organized into readable steps.

Generated ABI source, proving resources and canonical wire fixtures are excluded from formatting; update them through the protocol synchronization tools.

Generated ABIs and Solidity parameter types are available through `@invisi-labs/protocol/contracts`. Shared `Address` and `Hex` types belong to `@invisi-labs/core`; low-level cryptography remains independent of protocol interaction.

## Ethers transaction lifecycle

Operations export only `{ to, data, value }`. The application's ethers signer/provider owns gas estimation, fees, EVM nonce selection, sending, replacements and receipt waiting. Operations expose no transaction submitter, `submit()` or `wait()` wrapper. `Invisi` has no default signer: export signing requests for external protocol authorization and submit exported calls directly through ethers.

For a managed operation, `exportTransaction()` performs protocol preflight and persists its exposure before returning calldata. `trackTransaction(hash)` associates an application-owned transaction hash and returns a new uncertain handle; it neither broadcasts nor establishes that the transaction was mined. After ethers waits, `reconcile()` independently authenticates canonical calldata, receipts and consumed inputs before updating notes and reservations. Replacement hashes can be passed explicitly to `reconcile({ transactionHash })`; only matching frozen requests can confirm.

Applications that sign raw EVM transactions can persist the association before broadcasting: populate and sign with ethers, compute `keccak256(signedTransaction)`, track that hash, then call `provider.broadcastTransaction(signedTransaction)`. Exported operations retain their reservations even if the application crashes before recording a hash. Use operation recovery and explicit chain facts for unknown outcomes; never release inputs just because ethers returned an error or timeout. Registry operations use the same export/ethers/reconcile flow, with their independent registry nonce checked before export.

### WalletSession convenience sending

A `WalletSession` can delegate to an ethers signer explicitly configured in `WalletSessionOptions`, whether constructed directly or through `WalletSession.connect()`. Without a session signer, export calls for the application to send with ethers. The signer is an EVM gas/funding capability, separate from the Invisi wallet identity and private spending authority.

```ts
// Plain call: delegate to ethers without associating a managed operation.
const call = await ready.exportTransaction();
const transaction = await session.sendTransaction(call, { gasLimit: 1_000_000n });
await transaction.wait();
```

Alternatively, send a managed operation and record its hash automatically:

```ts
const transaction = await session.sendTransaction(ready);
await transaction.wait();
const tracked = await session.resume(ready.id);
await tracked.reconcile();
```

These are alternative flows. Both return the original ethers `TransactionResponse`, preserve the business call and session chain, and pass native fee/nonce options to ethers. The session neither waits nor retries. A session without an injected signer can still restore inventory and prepare operations, but cannot send. Passing a managed operation requires its record in this session's scope. Plain calls have no inferred operation association. If sending succeeds but hash persistence fails, the error reports the transaction hash for recovery; exported reservations remain held. Applications requiring hash persistence before broadcasting can continue to use the explicit raw signing/track/broadcast flow above.

## Gas reference before proving

Both `PreparedTransaction` and managed `Operation` provide synchronous `estimateGas()` after preparation. This performs no proving, chain RPC or `eth_estimateGas` call:

```ts
const prepared = await invisi.prepareTransfer({ wallet, protocol, tokenAddress, inputs, outputs });
const { gasUnits } = prepared.estimateGas();
console.log("Reference gas units:", gasUnits);
// Review the budget before starting expensive proving.
const request = await prepared.exportWalletAuthorization();
const signature = await ownerSigner.signTypedData(request.domain, request.types, request.message);
const ready = await (await prepared.withWalletSignature(signature)).prove();
const call = await ready.exportTransaction();
const finalGas = await signer.estimateGas(call);
```

`gasUnits` is a synchronous pre-proof reference, not a gas limit. The public result contains only this bigint field. It is never passed automatically to ethers sending. Combine it with current ethers fee data for a review UI; currency conversion and additional chain-specific fees belong to the application. Final estimation and transaction validity remain chain-dependent.

Exact measured shapes use the largest rounded-up receipt mean among matching records, including private policy variants. Unmeasured shapes use an upward-only workload envelope based on the worst observed sample per matching shape and circuit; duplicate policy variants are grouped before selecting a baseline. Signature funding and Permit each double an unmatched reference when absent from its baseline. Credit references require the current artifact and verification-key identity; historical Credit circuits cannot supply fallback costs. Historical Funds references retain the family-capacity fallback. These coarse references are not guaranteed upper bounds.

All funds and Credit preparation methods support this API. A recursive member has no standalone transaction cost and throws; estimate the complete aggregate separately. Unknown operation kinds/targets also throw. Custom exact deployment/circuit/shape measurements take priority through `new Invisi({ ..., gasBenchmarks: defineGasBenchmarks(teamCatalog) })`. Validation checks record format, not publisher authenticity. Session construction snapshots custom catalogs. Token behavior, screening, storage/tree occupancy, chain execution rules and deployment modifications can change actual costs. Recheck references when updating contracts or circuit assets.

### Current receipt matrix

Current Credit measurements use authenticated BB6.0.0 verifiers, Solidity0.8.38 optimizer200 and Anvil Prague with a 500,000,000 block gas limit. Normal Factory/CREATE deployments use no injected code or storage. Three independently proved transactions per row restore the same 123-leaf snapshot, payout balance and allowance baseline. Setup, funding and approvals are excluded; each receipt includes the complete business transaction. Both top-up variants start with daily/monthly usage10 and preserve all four usage fields. The changed variant lowers limits to50/5/0. Source content fingerprints, dirty base revision, compiler artifacts, manifests, toolchain and all deployed verifier/runtime hashes are recorded in the catalog.

Prague in this benchmark does not impose the EIP-7825 transaction gas cap. The 120-input partial draw exceeds16,777,216 gas and cannot fit chains enabling that cap; use a smaller batch on those chains. A lower network block gas limit can also make a measured shape unmineable.

| Shape | Capacity | Mean gas (rounded up) | Observed min–max |
| --- | ---: | ---: | ---: |
| `create-credit-caller-0x0` | 10 | 1,574,628 | 1,574,576–1,574,696 |
| `create-credit-1x1` | 10 | 1,671,545 | 1,671,485–1,671,641 |
| `draw-credit-1-partial` | 1 | 1,588,287 | 1,588,255–1,588,303 |
| `draw-credit-1-full` | 1 | 1,042,840 | 1,042,812–1,042,884 |
| `draw-credit-12-partial` | 12 | 3,102,979 | 3,102,871–3,103,171 |
| `draw-credit-12-full` | 12 | 1,536,687 | 1,536,675–1,536,711 |
| `draw-credit-50-partial` | 50 | 8,015,357 | 8,015,149–8,015,473 |
| `draw-credit-50-full` | 50 | 3,216,764 | 3,216,708–3,216,840 |
| `draw-credit-120-partial` | 120 | 17,458,420 | 17,458,224–17,458,524 |
| `draw-credit-120-full` | 120 | 6,289,688 | 6,289,576–6,289,768 |
| `top-up-credit-1x1-unchanged-limits` | 10 | 1,711,318 | 1,711,282–1,711,390 |
| `top-up-credit-1x1-changed-limits` | 10 | 1,711,366 | 1,711,318–1,711,438 |
| `cancel-credit-1` | 1 | 985,683 | 985,543–985,795 |

The nine Funds rows remain historical measurements from protocol92ef274, BB5.2.1, Solidity0.8.27 and Osaka; they were not remeasured in this Credit run. Historical Credit rows have been removed.

Reproduce with the authenticated current Protocol artifacts and a matching BB executable:

```sh
pnpm build
BB_BINARY_PATH=/path/to/bb node scripts/benchmark-gas.mjs
```

The collector starts and stops its own isolated loopback Anvil node on port18945. It never uses public RPC or modifies deployment catalogs. It runs `forge build`, fingerprints tracked and untracked executable sources, and rejects changes during the run. A clean commit is not required. `INVISI_PROTOCOL_DIR`, `GAS_BENCHMARK_PORT` and `GAS_BENCHMARK_OUTPUT` override source, private port and output. `GAS_BENCHMARK_CASES` selects comma-separated case IDs; subsets write a `.partial` result without replacing the catalog. Full publication occurs atomically after all measurements and identity checks pass.

Application metadata is always raw `Uint8Array` in `NoteOutput.create({ payload, ... })` and `Note.payload`. Use `fundsV1.encode({ memo })` or `creditV1.encode({ memo })` before preparation, and explicitly call the corresponding `.decode(note.payload)` after authenticated decryption. These are pure external application codecs: no codec registry is injected into Invisi, WalletSession, viewers or disclosure handles. Built-in memo encoders accept UTF-8 text or bytes, capped at256 encoded bytes. The generic raw payload limit is the remaining envelope budget, not the built-in memo limit. Omitted funds/create payloads become empty bytes; Credit top-up and partial draw preserve previous raw bytes unless an explicit replacement is supplied. `new Uint8Array()` clears all application metadata. Decryption never attempts application decoding, including for built-in or unknown application formats.

Memos are encrypted and authenticated with each delivery. They do not enter financial commitments or nullifiers. Commitment-only disclosures exclude memos; a scoped payload-key disclosure reveals the selected envelope's memo. Financial Credit recovery from a bad child envelope recovers the balance but leaves an unknown child memo absent. Funds and Credit envelope codec version 1 are independent of the unified Factory/Protocol version 1 and `/v1` Protocol RPC API. Use runtime-code pins for a deployment that supports these memo formats; historical immutable deployments retain their original wire format.

### Per-Credit spending limits

`prepareCreateCredit` accepts private `singleLimit`, `dailyLimit` and `monthlyLimit` values in token base units. Zero disables a limit. Each Credit input is checked independently, including a draw of its entire balance. Daily and monthly counters use UTC Gregorian periods from the explicit chain timestamp and reset only when that calendar period changes. Owner-authorized top-up can replace any of the three limits; an omitted limit inherits its previous value and zero explicitly disables it. Top-up preserves all four usage fields. Consumption is counted even while a limit is disabled. Reducing a daily or monthly limit below its used counter freezes further draws until that UTC period changes; no top-up resets usage.

Draw preparation binds the chain block timestamp to its proof statement without adding caller-supplied period fields to calldata. Prepare and authorize again if the UTC period changes before submission. Financial remainder recovery requires the confirmed draw block's timestamp, authenticated through the configured chain reader; preparation time and local wall-clock time cannot substitute for it. Credit deliveries use type 1, codec version 1 (header `0x81`) with domain `Invisi.CreditDelivery.v1` and lengths498–4096 bytes.

### Registered recipient lookup

After loading the service deployment with `getDeployment` or `Protocol.fromRpc`, call `protocolRpc.getReceivingAddress(ownerAddress)`. It returns `{ receivingAddress, nonce, block }` or `null` for an unregistered owner. The SDK checks the returned owner, viewing key, clue key, nonce and block encoding, then constructs the full `0i` address. The lookup needs no recipient private key and no ethers resolver in application code.

The service indexes Registry `ReceivingKeysSet` events; `block` is the indexed head, not necessarily the latest chain block. Newly registered/updated keys appear after confirmations and indexing. The client trusts the selected service for registered key data; the block reference alone does not authenticate storage. For independent resolution, use `EthersAddressResolver` with your Chain RPC. There is no silent direct-chain fallback when this explicit RPC query fails.

### Registration through Invisi

Configure `new Invisi({ provider, protocolRpc })`, then call `invisi.prepareRegistration({ wallet })` to register public receiving keys, or pass `update: true` to update an existing registration. Optional `deadline` uses Unix seconds. The method discovers the deployment for the ethers provider's chain, validates the Registry runtime and reads its independent nonce. It needs a full receiving-address wallet, not a private wallet or signer. The currently supported discovery adapter is `ProtocolRpcClient`; custom infrastructure can use the lower-level `AddressRegistry` directly.

Export `prepared.exportRegistrationAuthorization()`, sign the returned request in an external signing tool, and attach it with `prepared.withSignature(signature)`. Export the call and submit using ethers. Preparing never signs or broadcasts. Wallet remains an offline key/capability object, while the existing `AddressRegistry` interface remains available for explicit deployment composition.

### Uniform preparation errors and recipient discovery

All public `prepare*` methods on `Invisi`, `WalletSession`, and the SDK `AddressRegistry` reject with `InvisiError`. Constructor, connection, signing, proving, export and ethers submission errors retain their own contracts. Catch `InvisiError` and inspect `code`; do not branch on English message text. `operation` names the preparation method; `cause` retains the original exception when available. Existing error messages remain readable.

| Code | Meaning |
| --- | --- |
| `EVM_ADDRESS_NOT_REGISTERED` | The selected lookup has no registered receiving keys for this `0x` owner at the state it serves. Full `0i` addresses do not require registration. |
| `RECIPIENT_LOOKUP_FAILED` | Discovery failed or returned invalid keys; registration status is unknown. |
| `INVALID_RECIPIENT` | The supplied receiving-address encoding is invalid. |
| `MISSING_CAPABILITY` | Required infrastructure or permissions are absent; inspect `capability`. |
| `PREPARATION_FAILED` | Other preparation failure; inspect `message` and the original `cause`. |

Recipient errors include `address`, `field` (`to`, `amount`, `changeAddress`, `spender`, or `wallet`) and, for explicit payment outputs, zero-based `outputIndex`. Automatic change and Credit roles do not pretend to be entries in the caller's outputs array. Unknown/internal failures are not guessed into business categories by parsing their messages. A preparation failure never returns a prepared handle; existing preparation atomicity/reservation rules remain unchanged.

Recipients accept full `0i` addresses or EVM `0x` owners. A full address is validated locally and bypasses registration lookup. EVM recipients select `addressLookup: "chain"` for direct registry reads or omit it for default `"protocol-rpc"` indexed lookup. `new Invisi` accepts neither `addressLookup` nor a custom `addressResolver`. Indexed registration visibility follows confirmations/indexing; an absent record describes that indexed state, not necessarily the latest chain state. RPC discovery pins are checked against the supplied Protocol deployment, and the application trusts its selected RPC for the keys. There is no automatic fallback to a second source. For encrypted EVM outputs, `NoteOutput.create` fixes the financial opening offline; preparation resolves receiving keys, rejects missing registrations, and freezes delivery before signing or export. `envelope: false` skips lookup entirely.

```ts
try {
    const prepared = await invisi.prepareShield({ wallet, protocol, tokenAddress, outputs, funding });
} catch (error) {
    if (error instanceof InvisiError && error.code === "EVM_ADDRESS_NOT_REGISTERED") {
        console.error("No registered receiving keys for EVM owner:", error.address, error.outputIndex);
    } else {
        throw error;
    }
}
```

### Public and private wallets

`PublicWallet.fromAddress(receivingAddress)` creates an offline address-only object. It exposes owner identity, receiving public keys and public nullifier derivation, but has no `getViewer()`, `getDetector()` or `exportAuthorization()` methods. An EVM address contains only the owner identity; resolving its registered receiving keys remains an explicit preparation/read step.

`await Wallet.fromPrivateKey(privateKey)` restores the complete wallet and its private capabilities. Both types are accepted by registration and transaction preparation. A public wallet needs separately supplied viewing or authorization capabilities for operations that require them. Neither type submits transactions or silently signs requests.

This replaces `Wallet.fromAddress(...)`; import `PublicWallet` for address-only workflows.

Applications recovering explicit inputs without a store can fetch a canonical receipt with `EthersChainReader.getReceipt()`, decode it with `readProtocolLogs(receipt, protocolAddress)`, and call `decryptCandidates(logs, { context, viewing, confirmedThrough })`. The caller selects and independently checks the confirmation anchor. Recovery correlates deliveries with insertion events and authenticates decrypted commitments; it does not prove current membership or unspent state. Pass the resulting note, commitment, treeId and leafIndex directly to a `prepare*` method, which checks current spendability. No WalletSession or WalletStore is required.

For receipt-free discovery, use a reader-bound `ProtocolRpcClient.getOutputs(context, range)` to obtain encrypted indexed ordinary funds candidates in pages of at most 10000 blocks. The client validates canonical block anchors, field encoding, ranges and output positions. Decrypt each candidate locally with `ViewingCapability.decryptNote(ciphertext, { chainId, protocolAddress, tokenAddress, outputCommitment })`; catch non-recipient authentication failures separately from transport or state errors. `isSpent(context, nullifier)` reports indexed consumption only. Neither service completeness nor supplied positions are established by decryption: pass explicit inputs through preparation for independent membership and latest-chain spent checks. `getUpdates()` continues returning transaction references for managed receipt-authenticated synchronization.

### Unified private transfers and public payouts

Use `prepareTransfer({ wallet, protocol, tokenAddress, inputs, outputs, withdrawal? })` for private transfers, partial public withdrawals and full owner payouts. `withdrawal` is `{ to, amount }`, and `outputs: []` is valid with a positive public payout. Private outputs and public payouts can coexist; remaining funds produce private change. Public payout amounts remain visible on chain.

The prepared transaction derives its authorization requirement from the frozen statement. Complete input value paid to the original owner, with no private outputs, cash input or change, needs no owner spending signature. Every other use of old notes requires owner authorization. A PublicWallet plus complete notes therefore remains sufficient for delegated full owner payouts. Managed sessions use the same entry and may select explicit `commitments`. Standalone sweep/withdraw preparation methods and types have been removed; no compatibility aliases remain.


`ProtocolRpcClient.getTransactionUpdates(context, transactionHash, { signal })` queries RPC 1.1.4+ for one transaction. Its `ProtocolTransactionUpdates` result distinguishes `not_found`, `pending_index` and `indexed`; only the last state contains output and Credit transition arrays. Block metadata is independently checked through the configured Chain RPC reader, and every item must belong to the requested transaction. `receiptStatus` separately reports EVM success/reversion. The client preserves raw encrypted outputs and public event data, without polling or applying wallet state. Both the result and `ProtocolCreditTransition` types are exported by the RPC and SDK packages.

`ProtocolRpcClient.getCreditOutputs(context, range)` exposes indexed Credit envelopes through the existing updates transport. It preserves up to two distinct owner/spender payloads for one commitment, deduplicates identical deliveries and rejects conflicting canonical leaf metadata. The role must be authenticated locally by `ViewingCapability.decryptCredit(..., { ..., role })`. Ordinary `getOutputs()` continues excluding these envelopes. Before trusting restored receiving-key snapshots, independently match the selected role ciphertext against the canonical output, for example with `DisclosureVerifier.readOutput()`. Financial preparation independently checks membership, role, expiry, per-input limits and current nullifier state.

The SDK also exposes `creditPeriods(chainTimestamp)` for application-side UTC quota selection and `computeCreditNullifier(chainId, creditSharedKey, commitment)` for indexed spent observations. Neither requires a signing key; never send the shared key itself to the service. Batched Credit draws may have different owners but require one spender and one bound public payout. A single spender request authorizes the complete batch; every input's remaining Credit retains its own owner and historical receiving snapshots.

### Prebuilt note outputs

`NoteOutput.create` accepts explicit `chainId`, `protocolAddress`, `tokenAddress`, `amount` and a discriminated `recipient`. Its output is independent of a transaction preparation. `prepareShield` and `prepareTransfer`, including WalletSession variants, reject a different chain, Protocol or token rather than rewriting the output.

```ts
import { NoteOutput } from "@invisi-labs/sdk";

const output = await NoteOutput.create({
    chainId: protocol.context.chainId,
    protocolAddress: protocol.context.protocolAddress,
    tokenAddress,
    amount,
    recipient: { type: "invisi", address: bobAddress },
});
const outputs = [output];
```

Recipient modes:

- `{ type: "evm", address, envelope?: boolean, nonce?, addressLookup?: "chain" | "protocol-rpc" }`: `envelope` defaults to true. Preparation resolves registered receiving keys using the selected source, defaulting to `"protocol-rpc"`; an absent registration fails preparation. Set `envelope: false` to omit delivery and skip registration lookup.
- `{ type: "invisi", address, nonce? }`: a full `0i` address always generates delivery without a registry lookup.
- `{ type: "identity", identity }`: a precomputed per-note Poseidon2 identity, not an EVM wallet identity. This mode has no nonce or delivery, and does not reveal or fabricate the recipient's wallet identity/opening.

Factory-created encrypted EVM outputs expose `deliveryPending === true`. Preparation resolves their receiving keys and freezes generated delivery in the prepared transaction; the original immutable output remains an offline intent. Pending empty bytes do not represent a deliberate no-envelope output; `envelope: false` is explicit.

Address-mode nonces are canonical BN254 field elements in `[0, FIELD_MODULUS)`; omission samples one securely. `payload` belongs to the outer options and is accepted only for encrypted recipients. Plaintext-free identity outputs expose `note === undefined`; address outputs expose a detached complete note, which the recipient must retain when delivery is omitted.

For a merchant's precomputed request, build the output from its identity and independently check the supplied commitment:

```ts
const output = await NoteOutput.create({
    chainId,
    protocolAddress,
    tokenAddress,
    amount,
    recipient: { type: "identity", identity: merchantNoteIdentity },
});
output.assertCommitment(merchantCommitment); // Throws on mismatch.
```

`expectedCommitment` is not a constructor option. Commitment checks compare the independently computed result. A commitment binds chain, identity, token and amount; the Protocol address is separately checked as deployment context.

Funds outputs without delivery use paired empty ciphertext/clue bytes. Their commitments and exact positions are still indexed, but delegated FMD scanning skips them. A merchant retaining the original wallet identity and nonce can match its commitment, obtain a confirmed leaf/path, and prepare a spend. Creating an identity-only output alone does not provide that secret opening or prove payment. Credit role deliveries remain mandatory; ordinary funds change may omit delivery.

Repricing retains the fixed output identity, commitment and delivery. Mutable note/delivery/recipient snapshots are detached copies, and a local delivery fingerprint detects accidental corruption without authenticating storage. Create a fresh output for each distinct payment; retain one only for retries or repricing of that payment. All preparation outputs must be created with `NoteOutput.create`; raw output objects are rejected.

### Portable Note payment requests (IPR)

`PaymentRequest` describes the parameters for creating a Note output. `encodePaymentRequest(request)` and `decodePaymentRequest(ipr)` work offline and never select a nonce or resolve registered addresses.

```ts
import { NoteOutput, encodePaymentRequest, type PaymentRequest } from "@invisi-labs/sdk";

const request: PaymentRequest = {
    chainId: protocol.context.chainId,
    protocolAddress: protocol.context.protocolAddress,
    tokenAddress,
    amount,
    recipient: { type: "invisi", address: bobAddress },
};
const ipr = encodePaymentRequest(request);
const output = await NoteOutput.create(ipr);
const another = await NoteOutput.create(ipr, { nonce: chosenNonce });
console.log(output.ipp); // The original request, with no generated nonce written back.
```

`NoteOutput.create(request)` also exposes the canonical request as its immutable `ipp` string. Missing request nonces are chosen independently for each output. A fixed request nonce cannot be overridden with a different value, and identity recipients reject nonce execution options. Fixed-nonce and identity requests produce a fixed commitment; they do not bypass on-chain duplicate-commitment checks. Encrypted deliveries use fresh cryptographic randomness and need not have identical ciphertext when restoring a request.

EVM requests preserve the existing `recipient.envelope` default of true. Their local `recipient.addressLookup` is not encoded. A payer can select `NoteOutput.create(ipr, { addressLookup: "chain" })`; the default is `protocol-rpc`, resolved at preparation. This execution option applies only to encrypted EVM outputs. With object input, an explicit execution lookup takes precedence over the local recipient lookup. Invisi requests contain full public receiving materials and always use an envelope. Identity requests never contain an envelope or payload. An input request cannot include a commitment, signature, tree position, private key or arbitrary extra field.

#### Canonical binary layout

Text is `ipr:` followed by unpadded Base64URL. Integers are unsigned big-endian, addresses and public keys are raw bytes. The common header is:

| Field | Bytes |
| --- | ---: |
| version (1) | 1 |
| recipient type (1=evm, 2=invisi, 3=identity) | 1 |
| chainId (positive uint64) | 8 |
| protocolAddress | 20 |
| tokenAddress | 20 |
| amount (positive uint128) | 16 |

Append exactly one recipient body:

- EVM: ownerAddress (20), envelope flag (1), nonce-presence flag (1), nonce (32, only when present), then payloadLength (2) and payload when envelope is enabled.
- Invisi: ownerAddress (20), compressed viewingPublicKey (33), clueKey (32), nonce-presence flag (1), optional nonce (32), payloadLength (2), payload.
- Identity: identity (32), with no additional fields.

Flags are exactly 0 or 1. A missing nonce differs from a present zero nonce. Nonces are canonical BN254 fields; identities are nonzero canonical fields. Empty/absent payload uses length zero. Raw payload is limited to 3936 bytes, matching the current Funds envelope's 4096-byte maximum. Canonical requests without payload or nonce contain 88 bytes for unencrypted EVM, 90 for encrypted EVM, 154 for Invisi and 98 for identity; their complete text lengths are 122, 124, 210 and 135 characters. A fixed address-mode nonce adds 32 binary bytes.

Decoders reject unknown versions/types/fields, invalid addresses or key materials, out-of-range values, invalid flags, padding/noncanonical Base64URL, truncation and trailing bytes. The format does not authenticate the request issuer or assert on-chain receipt. Verify the request source, chain and deployment before paying.

Language-neutral vectors include structured values, exact binary hex and complete encoded strings in [requests.json](packages/sdk/src/payment-request/testdata/requests.json). `python3 scripts/generate-payment-request-vectors.py` regenerates them independently using Python standard-library binary encoding, without invoking the TS codec. The codec supports Note payment requests.

### Offline payment Notes (IPN)

IPN privately delivers a complete funds Note opening. It uses `ipn:` plus canonical unpadded Base64URL, with a fixed 149-byte body and 203-character text. It contains no application payload, ciphertext, clue, viewing key, spending key or signature.

```ts
import { PaymentNote } from "@invisi-labs/sdk";

// Use the final prepared/quoted plan so generated change is included.
const ipn = prepared.getOutputs()[0].exportPaymentNote();
// Deliver privately; this string alone does not prove that a payment was mined.
const note = await PaymentNote.from(ipn);

// Protocol.fromRpc(protocolRpc, provider) captures the public verification connections.
const verified = await note.verify(protocol);
// Confirms the opening and canonical Merkle membership. Spent Notes may pass.
console.log(verified.checkedAt.number);

const spendable = await note.verifySpendable(protocol, ownerWallet);
// Additionally requires this owner's spending Wallet and a currently unspent nullifier.
const input = spendable.toInput();
console.log(spendable.spendabilityCheckedAt.number);
```

`NoteOutput.exportPaymentNote()` also exports a created output directly. Neither export asserts that the transaction was mined. Both stateless `PreparedTransaction` and managed session operations expose detached `getOutputs()` snapshots, including change. An identity recipient has no recoverable owner/nonce opening and rejects IPN export. Credit openings have no IPN export.

`PaymentNote.from(ipn)` validates the encoding and recomputes identity and commitment. `verify()` checks deployment context and code, obtains a commitment lookup, validates the Merkle path, independently checks the Protocol's accepted root through the chain connection, and rechecks canonical blocks. It does not inspect spent status or wallet authority. `verifySpendable()` includes those checks, requires an actual owner `Wallet` with spending authorization capability, and checks the latest chain nullifier/root state without signing. `toInput()` is available only on the spendable result. Returned paths, blocks and inputs are detached copies.

Both methods accept `{ confirmations }` (default 1). The verification anchor is the indexed head or the requested confirmation-depth block, whichever is earlier. A manually constructed Protocol can supply connections explicitly: `{ protocolRpc, provider, confirmations }` or `{ protocolRpc, chainReader, confirmations }`. Protocol RPC is an untrusted index; chain reads provide the verification anchor. An absent lookup may mean indexing has not caught up. Match the amount and token to your business request before accepting payment. Spendability is a point-in-time observation; transaction preparation and simulation still check operation-specific authorization and execution restrictions.

#### IPN binary layout

All integers are unsigned big-endian. Addresses and field elements are raw bytes.

| Field | Bytes |
| --- | ---: |
| version (1) | 1 |
| chainId (positive uint64) | 8 |
| protocolAddress | 20 |
| tokenAddress | 20 |
| amount (positive uint128) | 16 |
| ownerAddress | 20 |
| nonce (canonical BN254 field, zero allowed) | 32 |
| commitment (nonzero canonical BN254 field) | 32 |

`encodePaymentNote` and `decodePaymentNote` provide offline structural encoding and decoding; semantic commitment validation is performed by `PaymentNote.from`. Unknown versions, extra fields, malformed addresses, invalid ranges, padding, nonzero unused Base64URL bits and nonexact lengths are rejected. Independent Python-generated wire vectors are in [notes.json](packages/sdk/src/payment-note/testdata/notes.json); regenerate with `python3 scripts/generate-payment-note-vectors.py`.

### Raw application payloads and fixed SDK envelopes

`prepareShield` and `prepareTransfer` accept `NoteOutput` instances created by the factory. The SDK always writes envelope v1, with first byte `0x01` for funds or `0x81` for Credit. Applications cannot select or inject custom envelope versions. Decryption dispatches by the authenticated header; unsupported envelope versions reject. Future SDK releases may implement another envelope version without coupling it to application schemas or the protocol/circuit version.

The encrypted body is `fixedFields | payloadLength2 | payloadBytes`. Fixed funds fields occupy80 bytes (`ownerAddress32 | amount16 | nonce32`); Credit recovery fields and both receiving-key snapshots occupy418 bytes. The unsigned big-endian payloadLength counts all following application bytes and may be zero. Exact body length is checked. Envelopes are bounded at4096 bytes: funds160..4096 with at most3936 payload bytes, Credit498..4096 with at most3598. No application bytes affect financial commitment/nullifier formulas, but complete ciphertext/clue bytes remain bound to transaction authorization/proof delivery hashes. Financial context, recipient, Credit keys/policy and commitment checks remain SDK-owned.

The outer envelope is `typeAndVersion1 | ephemeralKey33 | salt16 | iv12 | encryptedBody | GCMtag16`. The high bit identifies funds/Credit; the remaining seven bits encode the SDK envelope version. HKDF/AAD domains remain `Invisi.NoteDelivery.v1` and `Invisi.CreditDelivery.v1`. Contract and Protocol RPC transport remains opaque, with the4096-byte resource bound, uint16 batch framing and68-byte clues. Neither requires application codec registration.

Built-in pure application codecs are symmetric:

```ts
const outputs = [await NoteOutput.create({
    chainId, protocolAddress, tokenAddress, amount,
    recipient: { type: "invisi", address: bobAddress },
    payload: fundsV1.encode({ memo: "Invoice INV-1042" }),
})];
const note = await viewer.decryptNote(ciphertext, context);
const data = fundsV1.decode(note.payload);
if (data.memo) console.log(decodeMemoText(data.memo));
```

Built-in bytes are `payloadVersion1 | memo0..256`: one version byte followed directly by memo bytes. There are no flags, return-address fields, application format identifiers or reserved identifier ranges. `fundsV1` and `creditV1` accept only `{ memo }`, preserve every memo byte (including leading0/1), and reject unsupported fields or versions and oversized memos when explicitly invoked. The application chooses its decoder; SDK note decryption never interprets application data.

Addresses, refund instructions or other business fields belong to application-defined raw payloads and their own encoders. They have no built-in payment, identity or refund semantics. A commitment-opening disclosure excludes application bytes; a scoped payload-key disclosure exposes the entire selected envelope, including any custom application content. Disclosure scope exposes `revealsPayload`, without assuming a return-address field exists; fixed receiving-key snapshots are disclosed for Credit envelopes. Financial Credit recovery from a bad child ciphertext does not fabricate authenticated child application bytes.

Custom applications use exactly the same flow: `payload: orderV1.encode(data)`, then `orderV1.decode(note.payload)` outside the SDK. The codec handles only application bytes and never receives financial fields, viewing/spending keys, nonces or Credit recovery secrets from the SDK. Use validated JSON/UTF-8 or any agreed binary format, with any application versioning it needs; no format discriminator is required. Unknown application formats remain copied raw bytes and can be parsed later; no unknown-format fallback or implicit parsing occurs.

`ProtocolRpcClient.getEncryptedOutputs()` returns raw indexed candidates of every type/version. `getOutputs()` and `getCreditOutputs()` select by type only, preserving unknown envelope versions for future SDK upgrades. WalletSession, explicit discovery and disclosure all recover/retain raw payloads without an application registry. Low-level protocol builders still validate transport shape only. No compatibility registry, builder `.payload()` or versioned JavaScript schema objects remain.

### Transfer submission mode

`prepareTransfer()` fixes the transaction inputs, outputs and authorization request without choosing how it will be submitted. After wallet authorization, choose the mode in `authorized.prove({ execution: "aggregate" })`. Omission or `"single"` produces a directly submittable transaction; `"aggregate"` produces a member for a separate aggregate submission.

The public `TransactionProveOptions` extends prover progress/cancellation options with `execution?: TransactionExecution`, where `TransactionExecution` is `"single" | "aggregate"`. This is supported by both detached `PreparedTransaction` and managed `Operation`, including the explicit prover overload of `PreparedTransaction.prove`. Preparation rejects both `target` and `execution` rather than silently ignoring them.

- `single`: use `exportTransaction()` after proof and any funding authorization.
- `aggregate`: use `exportAggregateMember()`, aggregate exactly 4, 8 or 12 independent members and submit the complete call. Only the 14-slot transfer circuit supports this mode; Credit operations reject it.

Wallet authorization binds the same financial statement in either mode. A signature-funded transfer exports its funding request after proving, using the selected mode's request binding. The mode is frozen once proving succeeds; a ready handle cannot be re-proved to switch modes. Before proving, gas estimates describe the default single path; estimate the complete aggregate call with ethers after aggregation.

The low-level prover retains authenticated backend `ProofTarget` values `evm` and `noir-recursive`. Those identify toolchain formats and circuit keys; the SDK selects them from `execution` and never forwards this business option to prover backends. No circuit, verifier or on-chain encoding change is required.

## Managed wallet history

`session.getHistory({ tokenAddress })` returns detached private business views: `outgoing` contains locally prepared operation reviews, recipient outputs, raw payloads, current status and an optional transaction hash; `incoming` contains authenticated funds receipts, including spent ones. Omit the token filter to list assets without adding their amounts together. Construction records are not evidence of settlement or of any particular funding identity. Credit operations have review summaries; incoming Credit inventory remains separately stored.

`checkedThrough` is the independently persisted discovery cursor, advanced only when every page of a contiguous `refresh` range succeeds. It is not the latest block observed by operation reconciliation, and does not prove service completeness. Refresh from that cursor block again (or deployment on first use) so canonical checks can detect reorgs. Reset invalidated inventory before reconciliation. An indexer behind a chain observation may reject refresh; wait for it to catch up rather than skipping blocks.

`session.subscribe(listener)` returns an unsubscribe function and reports successful local session storage commits, without private event payloads. Read history/balance on demand and handle asynchronous UI errors. The host owns cross-tab/store subscriptions and RPC refresh scheduling. The Store adapter and its encryption key remain application-owned. Local construction history survives reopening the same encrypted Store; the private key alone cannot reconstruct outgoing private details after that Store is lost. ERC20 approvals and replacement-transaction tracking remain the responsibility of the host's ethers activity layer.

## Broadcaster service

The optional Node service lives in the separate `../invisi-protocol-broadcaster` repository. This SDK provides the browser-safe client, quote verification and fee preparation APIs. Applications may also submit directly with ethers.
