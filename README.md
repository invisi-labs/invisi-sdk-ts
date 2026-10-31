# Invisi TypeScript SDK

A capability SDK for browser wallets, merchant applications, proof services, aggregators and relayers. Independent objects compose through `Invisi`; applications explicitly choose permissions, infrastructure and runtime backends.

```ts
import { Invisi, Wallet, Protocol, ProtocolRpcClient } from "@invisi-labs/sdk";
import { JsonRpcProvider, Wallet as EthereumWallet } from "ethers";

const provider = new JsonRpcProvider(chainRpcUrl);
const signer = new EthereumWallet(fundingPrivateKey, provider);
const wallet = await Wallet.fromPrivateKey(evmPrivateKey);
const protocolRpc = new ProtocolRpcClient(protocolRpcUrl);
const protocol = await Protocol.fromRpc(protocolRpc, provider);
const invisi = new Invisi({ provider, protocolRpc, store, prover });
const session = await invisi.connect({ wallet, protocol });

await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });
const prepared = await session.prepareTransfer({
    tokenAddress,
    outputs: [{ to: recipientAddress, amount: 30n }],
});
// Review prepared.preview() locally before private authorization.
const authorized = await prepared.authorize();
const ready = await authorized.prove();
const transaction = await session.sendTransaction(ready);
await transaction.wait();
const tracked = await session.resume(ready.id);
await tracked.reconcile();
```

Deployment records pin a trusted multi-token Protocol, its runtime hash and scan start block. `Invisi.connect({ wallet, protocol })` validates that deployment; each operation selects `tokenAddress`. ERC20 assets require no registration. Protocol and circuit pauses, address screening, and funding/spend authorization control settlement. Exact-receipt checks reject fee-on-transfer deposits; rebasing assets are not supported. Teams deploy independent Protocols and publish their deployment through their own Protocol RPC. `Protocol.fromRpc(rpc, provider)` loads and pins the service record asynchronously. `new Protocol({ deployment })` accepts an explicitly supplied record synchronously. Select a trusted service, or pass an independently published record as `ProtocolRpcClient({ deployment, ... })` to pin the expected deployment. Chain validation checks consistency, not whether a deployment is official. Deployment schemas and parsing belong to `@invisi-labs/rpc`; the SDK keeps no deployment catalog. The Protocol repository's `deployment/deployment.json` includes the reproducible Anvil deployment; Protocol RPC reads that catalog. See [local deployment and custom records](examples/README.md#local-deployment). Indexed history and wallet state are scoped to the deployment; balances and coin selection remain asset-specific. `protocol.forToken(tokenAddress)` supplies low-level builders, while `protocol.aggregate(...)` supports mixed-token requests.

`Invisi` owns shared infrastructure: Chain RPC, Protocol RPC, store, prover and protocol authorization. `connect()` selects only `wallet`, `protocol`, optional `namespace`, and optional `viewing` or `authorization` overrides for delegated permissions. A complete wallet supplies these permissions automatically. Membership paths come from Protocol RPC; note nullifiers and public receiving keys are derived from the selected wallet. No separate `membership`, `nullifier`, `detector` or `receivingAddress` session options are needed. FMD delegation remains explicit on `refresh({ detectionKey })`.

This transfer spends private notes. Explicit public funding adds an EVM funding grant after the actual proof exists. Private authorization uses the original selected EVM account key in a separate signing domain; a funding signature or transaction sender cannot substitute for it. Funding and gas may use a separate account. Constructors neither start background tasks nor silently create storage, RPC clients or proving processes.

## Application-owned data without a Store

`WalletSession` manages inventory, selection, reservations and operation recovery. Applications that own their database can instead call `Invisi.prepareTransfer`, `prepareShield`, `prepareCreateCredit`, `prepareDrawCredit`, `prepareTopUpCredit` and `prepareCancelCredit` directly. These methods never read or write a WalletStore and do not create a hidden memory store. The managed and explicit paths share preparation, statement, witness, authorization, proof-verification and calldata logic.

```ts
const invisi = new Invisi({ provider, protocolRpc, prover });
const prepared = await invisi.prepareTransfer({
    wallet,
    protocol,
    tokenAddress,
    inputs: applicationSelectedNotes,
    outputs: [{ to: recipientAddress, amount: 30n }],
});

// Review privately before granting authorization.
const review = prepared.preview();
const authorized = await prepared.authorize();
const ready = await authorized.prove({ onProgress });
const call = await ready.exportTransaction();
const transaction = await signer.sendTransaction(call);
```

Each funds `NoteInput` contains `{ note, commitment, treeId, leafIndex }`. Explicit funds operations consume all supplied inputs; they do not silently select a smaller subset or call an application coin selector. Sweep may explicitly select a subset with `commitments`. Change defaults to the wallet's receiving address; signed operations may supply `changeAddress`. `CreditInput` contains `{ state, commitment, treeId, leafIndex, role }`; provide role-specific records through `creditInputs` and select the credits to use with the normal Credit operation options. Owner and spender inputs remain subject to their actual leaf-bound permissions.

The SDK validates note preimages, wallet identity, deployment/token scope, canonical membership, spent state and the frozen proof statement. Supplying a record does not make it trusted. Chain RPC and Protocol RPC remain infrastructure dependencies; a Store adapter does not.

`PreparedTransaction` is a local immutable operation handle. It supports `preview`, `authorize`, `prove`, `authorizeFunding`, caller-funded shield `ready`, `exportTransaction`, `exportProof` and `exportAggregateMember`. A public wallet may use a separate `WalletAuthorizationProvider` with `authorize(provider)`; a local prover may be supplied with `prove(prover, options)`, and a funding signer with `authorizeFunding(signer)`. Private authorization, public funding and gas payment remain independent.

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

A request is bound to the original immutable handle. Attaching a signature does not reconstruct that handle after a process restart; application recovery and transport remain separate concerns. Signing tools must display trusted business context for statement/request hashes, and must support the required typed-data format. Existing per-operation `authorize`, `authorizeFunding(signer)` and registry `authorize` remain convenience APIs. The `Invisi` constructor no longer accepts a default signer or funding signer; migrate those integrations to explicit request/signature boundaries and submit with ethers.

One Invisi instance may construct operations for multiple wallets by providing the wallet on every call. This does not permit mixing different owners' funds inputs in one arbitrary spend. Independent requests may be aggregated when the protocol permits it.

Applications own input reservations, concurrency across processes, persistence, broadcasting and receipt reconciliation. Detached handles provide no durable recovery or automatic balance updates; keep pending inputs reserved after exporting a proof/request until canonical consumption or genuine expiry is established. The SDK never uploads private notes to Protocol RPC. See [transfer](examples/03-funds/transfer.ts) for explicit NoteInput construction; a private database can supply the same typed inputs.

| Component | Responsibility |
| --- | --- |
| Protocol RPC service | Public history indexing, optional candidate detection and membership path construction. |
| `@invisi-labs/rpc` | Transport, deployment/version validation and independent checks of indexed anchors and paths. |
| Chain RPC and `@invisi-labs/sdk/ethers` | Canonical blocks, receipts, contract reads, spent checks and transaction submission. |
| `@invisi-labs/core` | Wallet keys and permissions, encryption/decryption, clue creation, commitments and nullifiers. `/address` parses addresses without a proving backend. |
| `@invisi-labs/protocol` | Deployment records, protocol statements/calldata, witness builders, registry operations and generated ABIs. |
| `@invisi-labs/prover` | Local witness execution, proving and proof verification through explicit `/native`, `/wasm` and `/aggregate` entries. |
| `@invisi-labs/sdk` | Wallet sessions, private inventory, reservations, operation workflows and infrastructure composition. Encrypted storage uses explicit `/memory`, `/sqlite` and `/indexeddb` entries. |
| `@invisi-labs/react`, `@invisi-labs/vue` | Thin operation lifecycle and cancellation wrappers. |

The SDK uses two RPC endpoints. Chain RPC supplies canonical blocks, receipts, contract reads and transaction submission. Protocol RPC indexes public history and returns candidate transaction references and membership paths. Construct `ProtocolRpcClient` explicitly and pass it to `Invisi`; membership access is injected automatically. `session.refresh({ fromBlock })` obtains candidates, independently fetches receipts through Chain RPC, decrypts locally and requests paths only for owned notes. The server cannot decrypt notes or create wallet proofs. The SDK has no local history-scanning fallback or public tree implementation.

Applications choose explicit `fromBlock` and optional `toBlock` ranges and own history pagination. Refresh also accepts `signal`, `pageSize` (1–100 blocks per request) and `reset`, and returns a `RefreshResult` with the final block, added note/Credit counts and balances. Optional `detectionKey: wallet.getDetector().exportKey()` explicitly delegates detection to the detection method only; it does not delegate viewing or authorization. Candidate filtering and authenticated decryption cannot establish complete history. Credit recovery needs parent and lifecycle transactions, including draws whose new envelopes cannot be decrypted. `protocolRpc.getStatus(protocol.context)` reports `indexedHead`, `detectionEnabled` and `checkedBits`; the reported head is not a completeness proof.

WalletSession prepares shield, private transfers, full/partial withdrawals, Credit creation, spender draws, unexpired owner top-ups and owner cancellation. AddressRegistry has its own registration nonce and standard owner EIP-712 or ERC-1271 authorization; direct owner calls use an empty signature. Registration is ready after signing and requires no prover. Aggregator accepts4/8/12 current slots14 recursive public members and needs no private wallet material. Combined ordinary slots select14/56/112/168; Credit draws select1/12/50/120.

Note delivery and discovery use canonical chain events. Credit role envelopes contain both complete receiving-key snapshots, so later draw/top-up delivery does not require a business service or a fresh registry lookup. Public ERC20 settlement on Credit draw/cancel remains bound to the note's payout addresses. Business invoices, quotes, orders and negotiations belong to applications.

Receiving addresses use a 138-character `0i` full address or the owner's standard 42-character EIP-55 `0x` address as the short form. Address APIs use strings: `wallet.getAddress()`, `wallet.ownerAddress`, and `registry.resolve(ownerAddress)`. Pass recipient strings directly to `prepareTransfer`; the SDK validates and resolves them internally using the configured resolver. `PublicWallet.fromAddress` provides public receiving material. `getAddress()` requires complete receiving keys; an owner-only import exposes `ownerAddress` immediately and resolves receiving keys explicitly through the selected registry. Viewing handles decrypt and permit full funds sweeps to the same EVM owner; detection handles filter; public nullifier helpers use each note nonce to reconcile spent state; WalletAuthorization authorizes a frozen private statement. Export only the capabilities needed by the recipient. Default JSON/inspect output redacts secrets. JavaScript process memory and these variable-time, unaudited cryptographic implementations are not hardware isolation.

State is scoped by namespace, chain, protocol and wallet identity. Balance snapshots expose known funds, reservations, spent-check block/hash and the candidate observation checkpoint `observedThrough`. Unknown spent state and an unchecked empty wallet return `availableKnown:null`. Candidate updates advance `observedThrough`; they do not establish complete history. Refreshes with no incoming candidates can refresh known spent state, but cannot establish absence of incoming funds. Explicit `session.refresh({ fromBlock, reset: true })` rebuilds inventory while retaining uncertain operations and reservations; subsequent history ranges must not reset it again. Ordinary RPC supplies a trusted canonical data source; this SDK is not a consensus light client.

`Disclosure.fromNote(note)` and `Disclosure.fromCredit(note)` create commitment openings; Credit openings retain only `creditSharedKeyHash`. `wallet.getViewer().discloseNote(ciphertext, context)` and `.discloseCredit(ciphertext, context)` authenticate an existing envelope and disclose only its derived payload key. Default JSON/inspect is redacted; explicit `export()` returns sensitive versioned JSON material and `Disclosure.fromExport(material)` imports it. `getScope()` describes the exposure: complete funds openings or payload keys permit consumption tracking and owner-only full sweep; a Credit payload key unlocks the entire role envelope, including `creditSharedKey` and receiving-key snapshots. Core `verify(output)` requires independently authenticated output data. `DisclosureVerifier` resolves successful canonical receipts and matching insertion/delivery events through a trusted deployment and RPC, with explicit confirmation policy. Results establish output content/inclusion, not payer identity, source of funds, spent state or complete wallet history. See [the disclosure walkthrough](examples/07-disclosure/index.ts) and [read-only chain verification](examples/07-disclosure/verify-on-chain.ts).

Persistent stores require caller-managed encryption keys. SQLite requires a compatible synchronous driver; the Node examples use `node:sqlite`. IndexedDB uses native CAS transactions. Memory storage is an explicit ephemeral choice. Back up the source EVM account private key, or its mnemonic/passphrase and original wallet derivation path, plus any externally rotated historical viewing keys. Invisi defines its KDF, not an HD path.

An exported or possibly broadcast proof keeps inputs reserved until canonical consumption or actual business expiry. A timeout, local abandonment, changed funding nonce, expired funding signature or currently unknown root does not revoke an exposed proof. Restore an operation by ID and reconcile it before retrying. Cancellation stops local work; it cannot revoke a transaction already sent.

[Numbered English examples](examples/README.md) show complete native/browser flows, public funding and Permit, Credit roles, registration, aggregation, discovery, durable recovery, frameworks and application-owned input records. Applications own review, authentication, key management and commercial policies.

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

## Source formatting

Run `pnpm format` to format handwritten sources, tests, examples and scripts, or `pnpm format:check` to check them without changes. `pnpm lint` and CI include the formatting check. The pinned formatter uses four spaces, double quotes, semicolons and a preferred width of 100 columns (140 in examples to keep walkthrough messages on one line). Complex control flow should also be organized into readable steps.

Generated ABI source, proving resources and canonical wire fixtures are excluded from formatting; update them through the protocol synchronization tools.

Generated ABIs and Solidity parameter types are available through `@invisi-labs/protocol/contracts`. Shared `Address` and `Hex` types belong to `@invisi-labs/core`; low-level cryptography remains independent of protocol interaction.

## Ethers transaction lifecycle

Operations export only `{ to, data, value }`. The application's ethers signer/provider owns gas estimation, fees, EVM nonce selection, sending, replacements and receipt waiting. Operations expose no transaction submitter, `submit()` or `wait()` wrapper. `Invisi` has no default signer: export signing requests for external protocol authorization and submit exported calls directly through ethers.

For a managed operation, `exportTransaction()` performs protocol preflight and persists its exposure before returning calldata. `trackTransaction(hash)` associates an application-owned transaction hash and returns a new uncertain handle; it neither broadcasts nor establishes that the transaction was mined. After ethers waits, `reconcile()` independently authenticates canonical calldata, receipts and consumed inputs before updating notes and reservations. Replacement hashes can be passed explicitly to `reconcile({ transactionHash })`; only matching frozen requests can confirm.

Applications that sign raw EVM transactions can persist the association before broadcasting: populate and sign with ethers, compute `keccak256(signedTransaction)`, track that hash, then call `provider.broadcastTransaction(signedTransaction)`. Exported operations retain their reservations even if the application crashes before recording a hash. Use operation recovery and explicit chain facts for unknown outcomes; never release inputs just because ethers returned an error or timeout. Registry operations use the same export/ethers/reconcile flow, with their independent registry nonce checked before export.

### WalletSession convenience sending

A directly constructed `WalletSession` can delegate to an ethers signer explicitly configured in `WalletSessionOptions`. Sessions created through `Invisi.connect()` have no default signer and should export calls for the application to send with ethers. The signer is an EVM gas/funding capability, separate from the Invisi wallet identity and private spending authority.

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
const ready = await (await prepared.authorize()).prove();
const call = await ready.exportTransaction();
const finalGas = await signer.estimateGas(call);
```

`gasUnits` is a synchronous pre-proof reference, not a gas limit. The public result contains only this bigint field. It is never passed automatically to ethers sending. Combine it with current ethers fee data for a review UI; currency conversion and additional chain-specific fees belong to the application. Final estimation and transaction validity remain chain-dependent.

Exact measured shapes use the largest rounded-up receipt mean among matching records, including private policy variants. Unmeasured shapes use an upward-only workload envelope based on the worst observed sample per matching shape and circuit; duplicate policy variants are grouped before selecting a baseline. Signature funding and Permit each double an unmatched reference when absent from its baseline. Credit references require the current artifact and verification-key identity; historical Credit circuits cannot supply fallback costs. Historical Funds references retain the family-capacity fallback. These coarse references are not guaranteed upper bounds.

All eight direct preparation methods support this API. A recursive member has no standalone transaction cost and throws; estimate the complete aggregate separately. Unknown operation kinds/targets also throw. Custom exact deployment/circuit/shape measurements take priority through `new Invisi({ ..., gasBenchmarks: defineGasBenchmarks(teamCatalog) })`. Validation checks record format, not publisher authenticity. Session construction snapshots custom catalogs. Token behavior, screening, storage/tree occupancy, chain execution rules and deployment modifications can change actual costs. Recheck references when updating contracts or circuit assets.

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

Optional output memos accept UTF-8 text or `Uint8Array` and are limited to 256 encoded bytes. Funds/shield outputs use `{ to, amount, memo }`; Credit creation uses `memo`, top-up accepts an optional replacement, and each draw entry can supply its remainder's `memo`. Top-up and partial draw preserve the previous memo when no override is supplied. Use `memo: ""` to clear it. Decryption returns copied raw bytes; use `decodeMemoText(bytes)` explicitly for strict UTF-8 decoding. Opaque bytes never require text or JSON decoding.

Memos are encrypted and authenticated with each delivery. They do not enter financial commitments or nullifiers. Commitment-only disclosures exclude memos; a scoped payload-key disclosure reveals the selected envelope's memo. Financial Credit recovery from a bad child envelope recovers the balance but leaves an unknown child memo absent. Funds envelope version 2 and Credit envelope version 5 are independent of the unified Factory/Protocol version 1 and `/v1` Protocol RPC API. Use runtime-code pins for a deployment that supports these memo formats; historical immutable deployments retain their original wire format.

### Per-Credit spending limits

`prepareCreateCredit` accepts private `singleLimit`, `dailyLimit` and `monthlyLimit` values in token base units. Zero disables a limit. Each Credit input is checked independently, including a draw of its entire balance. Daily and monthly counters use UTC Gregorian periods from the explicit chain timestamp and reset only when that calendar period changes. Owner-authorized top-up can replace any of the three limits; an omitted limit inherits its previous value and zero explicitly disables it. Top-up preserves all four usage fields. Consumption is counted even while a limit is disabled. Reducing a daily or monthly limit below its used counter freezes further draws until that UTC period changes; no top-up resets usage.

Draw preparation binds the chain block timestamp to its proof statement without adding caller-supplied period fields to calldata. Prepare and authorize again if the UTC period changes before submission. Financial remainder recovery requires the confirmed draw block's timestamp, authenticated through the configured chain reader; preparation time and local wall-clock time cannot substitute for it. Credit deliveries use envelope version5 with domain `Invisi.CreditDelivery.v3` and lengths498–754 bytes.

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

Recipient strings accept full `0i` addresses or registered `0x` owners. A full address is validated locally and bypasses registration lookup. Configure `new Invisi({ provider, protocolRpc, addressLookup: "chain" })` for direct registry reads, or omit `addressLookup` to use the default `"protocol-rpc"` indexed `ReceivingKeysSet` lookup. Indexed registration visibility follows confirmations/indexing; an absent record describes that indexed state, not necessarily the latest chain state. RPC discovery pins are checked against the supplied Protocol deployment, and the application trusts its selected RPC for the keys. An explicit `addressResolver` overrides source selection. There is no automatic fallback to a second source. Public receiving keys are resolved during preparation and frozen into deliveries before signing or export.

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

For receipt-free discovery, use a reader-bound `ProtocolRpcClient.getOutputs(context, range)` to obtain encrypted indexed ordinary funds candidates in pages of at most 100 blocks. The client validates canonical block anchors, field encoding, ranges and output positions. Decrypt each candidate locally with `ViewingCapability.decryptNote(ciphertext, { chainId, protocolAddress, tokenAddress, outputCommitment })`; catch non-recipient authentication failures separately from transport or state errors. `isSpent(context, nullifier)` reports indexed consumption only. Neither service completeness nor supplied positions are established by decryption: pass explicit inputs through preparation for independent membership and latest-chain spent checks. `getUpdates()` continues returning transaction references for managed receipt-authenticated synchronization.

### Unified private transfers and public payouts

Use `prepareTransfer({ wallet, protocol, tokenAddress, inputs, outputs, withdrawal? })` for private transfers, partial public withdrawals and full owner payouts. `withdrawal` is `{ to, amount }`, and `outputs: []` is valid with a positive public payout. Private outputs and public payouts can coexist; remaining funds produce private change. Public payout amounts remain visible on chain.

The prepared transaction derives its authorization requirement from the frozen statement. Complete input value paid to the original owner, with no private outputs, cash input or change, needs no owner spending signature. Every other use of old notes requires owner authorization. A PublicWallet plus complete notes therefore remains sufficient for delegated full owner payouts. Managed sessions use the same entry and may select explicit `commitments`. Standalone sweep/withdraw preparation methods and types have been removed; no compatibility aliases remain.
