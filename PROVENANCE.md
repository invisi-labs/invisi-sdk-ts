# Independent Provenance client

The Provenance family is separate from the existing transaction circuits and Note/Credit spending APIs. It has depth 32, exactly 11 public inputs, and capacities 1–10, then 20–190 in steps of 10. The trusted release manifest SHA-256 is `cf07e868bd354382f2137f789e6b049563289b779e061728050936d23076f31a`.

Sync authenticated public artifacts from a local protocol checkout:

```sh
python3 scripts/sync-provenance.py ../invisi-protocol
```

This checks the pinned manifest and every artifact/VK digest before copying 28 independent artifacts and keys into `.cache/provenance/`. Existing main circuit manifests, assets and version numbers remain separate. The cache is generated and ignored by Git. The reviewed manifest is tracked with this SDK; updating its pin requires an explicit release review.

Configure scope (chain, protocol), current chain generation, provider, trusted Ed25519 public keys indexed by signingKeyId, and the reviewed manifest digest locally. Responses never establish trust. Certificate payloads use the fixed 269-byte encoding and raw 64-byte Ed25519 signatures. Empty-tree certificates are supported, but proof sources must contain at least one leaf.

The v1 metadata methods `provenance_getVersion`, `provenance_getStatus` and `provenance_getRules` use a deployment scope of chain and protocol only. The service maintains one rule set. Rules, roots and tracking queries have no rule-selection argument; unexpected scope fields are rejected. `getRules` exposes the single configured rules and signed-key rotation history, not a selectable list. Service replicas compare one private canonical rules snapshot at startup and reject conflicting configurations; provider endpoints and evolving risk datasets do not change this snapshot or revoke finalized recognition.

The recommended flow is: fetch a signed root, verify its trust and generation, locally replay paginated public leaves at that fixed root, check contiguous indexes and scoped commitment hashes, verify the final certified root, obtain local membership paths, build the private witness locally, and prove locally. No private opening, owner, nonce, amount, witness, IPN or private key belongs in a service request. The clients reject private-material field names in public submissions. Default membership lookup is a local tree replay; no per-input commitment query is necessary.

Export produces `{operationIndex, proofBundle}`. The bundle has only `format`, `circuitId`, `manifestSha256`, `target`, `publicInputs`, `proof`, and `rootCertificates`; format is `invisi-provenance-proof-v1`, circuit IDs are `provenance_k<K>`, and target is `evm`. Bundle validation checks scope, generation, configured keys, source ordering, sourcesDigest, capacity, operation digest limb bounds, and binding. A host-supplied prover must also verify its output against the authenticated local VK.

Use `evaluateTransaction` / `EvaluateTransaction` / `evaluate_transaction` before broadcast. Successful private-input preflight durably admits one opaque tracking task per scope/generation/native operation digest. Retain its tracking ID and use `getTracking` / `GetTracking` / `get_tracking` or the bounded wait method; normal indexing and the source worker match the transaction and automatically collect its already-verified evidence. No transaction-hash notification or duplicate `submitProof` is required. `submitProof` and proof-job polling remain an explicit direct/self-broadcast fallback. Evaluate, submit and job responses must include matching scope, generation, providerId, signingKeyId and manifestSha256. A generation change requires refreshing canonical roots and local paths; it never authorizes changing already signed calldata. Recognition status is independent of whether a Note has been spent. Existing transaction journal schemas are unchanged; the independent recovery coordinator below persists source evidence in its own encrypted namespace.

Source-gated Broadcaster quotes bind `keccak256(abi.encode("InvisiBroadcasterProvenanceIntentV1", originalRequestHash))`. The signed Quote retains its six EIP-712 fields; outer metadata contains `provenanceRequired:true` and `requestHashFormat:"invisi-broadcaster-provenance-intent-v1"`. Missing/unexpected enablement metadata fails closed. `estimateQuote(data)` requires concrete transaction data but no proof; `getQuote(data, proofSidecars)` accepts final source sidecars and returns the signed quote and verified tracking.

## TypeScript entrypoints

- `@invisi-labs/sdk/provenance` (also `@invisi-labs/core/provenance`): primitives, `RecognizedTree`, `buildWitness`, `authenticateManifest`, `exportSidecar`, `validateProofBundle`, `ProvenanceClient`.
- `@invisi-labs/prover/provenance`: `LocalProvenanceProver`, genuine in-process Noir 1.0.0 and BB 6.0.0 WASM proving plus independent local verification. The host supplies authenticated manifest/artifact/VK bytes through `loadAssets`; no VK URLs or remote prover endpoint are accepted. `crsPath`/`wasmPath` configure the public runtime resources.
- `BroadcasterClient` accepts optional `provenanceRequired: true` in configuration. Pass sidecars to `quote(data, context, sidecars)` and `submit(data, signedQuote, sidecars)`. Disabled configurations reject provenance metadata.

Use `client.syncRecognizedTree(rootId, certificate, {maxLeaves})` for fixed-root public replay. The default replay budget is 100,000 leaves; raise it explicitly for a larger trusted snapshot.

Genuine local K1/K10 proof integration: `INVISI_PROTOCOL_ROOT=../invisi-protocol INVISI_CRS_PATH=... pnpm --filter @invisi-labs/prover exec vitest run src/provenance.test.ts`.

## Signing-key rotation

Pin the provider and genesis signing public key externally. `getPolicy` may return `initialSigningPublicKey` and public `keyRotations`; these fields never establish trust themselves. Verify the complete history (or an explicitly pinned checkpoint including validity intervals) with `verifyRotationChain` / `VerifyRotationChain` / `verify_rotation_chain`. The shared 169-byte rotation payload uses version 1, provider, old/new key IDs, new public key, activation time and previous rotation hash. Verify the old trusted key signature, SHA-256 new key ID, provider, previous hash, strictly increasing activation times and a caller-supplied current time.

Apply the returned keyring explicitly with `withRotationHistory` / `WithRotationHistory` / `TrustContext::with_rotation_history`; the clients do not accept unknown keys automatically. Historical certificates issued before a key's retirement remain valid; that old key cannot issue certificates at or after the successor's activation. `getPolicy` alone permits an unknown reported current key so its history can be fetched for explicit verification; proving, evaluation, submission and job responses still require trusted keys.

Optional service membership lookup requires an explicit interest-disclosure opt-in; returned paths are still checked locally against the trusted certificate. Local paginated replay remains the default.

## Independent recovery coordinator

Recovery is opt-in and separate from Note/Credit inventory, signing, reservations and the App. Construct an encrypted recovery store over caller-owned atomic ciphertext records, then inject the current trusted Provenance client and local host capabilities. There is no default plaintext file store. The AES-256-GCM record purpose/AAD binds `Invisi.Provenance.RecoveryRecord.v1`, the namespaced record key and CAS revision; wrong keys, keys from another record, and stale revisions fail closed. Local revisions are bounded to 2^53−1 in all three languages so JSON/CAS round trips remain exact for TypeScript. The host keeps encryption keys and raw openings separately; recovery records contain only public evidence and frozen public transaction identifiers.

Default `prepare` / `Prepare` first authenticates the frozen statement, calls actual preflight and requires an allowed matching tracking acknowledgement. It persists `deliveryMode: "tracked"`, the tracking ID and the complete sidecar, certificates, scope, manifest, generation, operation digest, ordered input nullifiers, operation index, original calldata/hash, signed request hash and base idempotency key with `broadcast_possible` **before returning permission for external broadcast**. A crash after receiving permission cannot make the record unfrozen. The host continues to own its existing transaction journal and input/nonce reservations. `markBroadcast` records a known transaction hash but is not the safety fence. Local cancellation stops proving/polling and never cancels an external broadcast or releases reservations.

`resume` / `Resume` / `run` first calls the injected host's authenticated reconciliation of the original frozen transaction. In tracked mode it polls the persisted tracking capability, checks any matched locator against primary reconciliation and confirms the exact operation through `getOperationRecognition`; it never automatically submits another copy of the source proof. Missing tracking does not silently downgrade. In explicit `prepareDirect` / `PrepareDirect` / `prepare_direct` mode, confirmed locators are persisted before source submission. An uncertain direct-mode network response is retried with the same key, derived as `base:SHA256(canonical JSON proofBundle)` (base: 1–63 printable ASCII bytes, must not start with reserved `internal/`, derived key: at most 128 bytes; checked before permission); a replacement bundle gets a different submission key. The original calldata, callee/scope, token, ordered nullifiers and operation digest remain frozen. The signed request hash also remains fixed, so the coordinator never silently changes nonce, fee or quote. The host must decode/authenticate this frozen transaction and independently verify local proofs; these are required capabilities, not trust inferred from a service response.

In explicit direct mode, after proof submission the coordinator stores the job ID and polls it. **A `valid` job only sets `proofValid`; completion requires `getOperationRecognition` for the exact canonical locator and matching operation digest/nullifiers to return `recognized` with its operation checkpoint.** Mixed funding or dependencies can remain `pending_source` or `source_rejected`; provider outages leave resumable state, and resuming a rejected source operation can observe a later decision without changing any old Note's status. No output Note is required, so a zero-output withdrawal still completes through operation recognition.

Tracking responses are scoped trusted envelopes containing `tracking: {id, status, expiresAt, operationDigest, matched?, reasonCode?, checkpointSequence?}`. IDs are 48 lowercase hex characters; queries use the pinned chain/protocol deployment. Single-operation evaluation has `tracking` on its flat decision; aggregate decisions each carry their own tracking, selected by operation index. States are `pending_confirmation`, `pending_source`, `recognized`, `expired`, `superseded`, and `stale_generation`. Matched/published states require a concrete transaction/block/member locator; SDKs reject unknown states, untrusted identities, mismatched digests/locators and stale-generation capabilities. `expired`/`superseded` are terminal and never trigger another transaction. `expiresAt` is canonical decimal seconds; only the service's authenticated mature chain prefix can establish expiry, so local clock/index lag does not itself expire a task. Bounded waits can time out and be resumed. No-proof public funding/Credit lifecycle operations are already indexed and do not need tracking.

Tracked reproof re-evaluates the unchanged candidate and persists a fresh/coalesced tracking ID before continuing. If the already-mined candidate's original deadline prevents a new preflight, the host must explicitly choose `prepareDirect` with a locally regenerated sidecar and authenticated mined locator; the SDK never changes its deadline/nonce/fee/quote or silently bypasses tracking. Raw openings remain exclusively in host-encrypted storage/local proving capabilities.

Current job wire states are `queued`, `verifying`, `retryable_error`, `valid`, `invalid` and `stale_generation`. `retryable_error` keeps the same job pending for the worker to retry; `invalid` becomes local `proof_rejected` and allows explicit local reproof with a different bundle-derived key. `stale_generation` requires fresh host reconciliation and reproof. Unknown spellings fail closed; none of these cryptographic-job states is a funding/source risk rejection. Public `waitProofJob` returns terminal `stale_generation` immediately and rejects unknown states.

Recovery completion is confirmed by the pinned source service's operation-recognition response under the configured trust model. It is not independent authentication of output Note membership. Receivers still separately authenticate root certificates, canonical anchors and membership when accepting a Note.

A generation change or reorg returns `needs_reproof` after host reconciliation. With explicit local reproof enabled, the host may supply a new sidecar only after the service trust context is explicitly updated to that generation; the coordinator rechecks certificates, binding, ordered input digest and the entire frozen statement. No remote proving URL or raw opening argument exists. On interruption/restart, instantiate another coordinator over the same encrypted records and call resume/run with the same ID. Local `filterRecognizedCommitments` / `FilterRecognizedCommitments` / `filter_recognized_commitments` helpers filter through a rebuilt `RecognizedTree`; protocol spendability and source recognition remain separate, with no per-note network interest query.

Recovery state-machine tests use explicitly marked synthetic proof bytes and real signed root certificates; they validate recovery/encryption behavior and do not claim another native-prover or App integration test.

TypeScript: `EncryptedRecoveryStore.fromKey(existingAtomicRecordStore, aesGcmKey)` (or `fromBytes`), then `new RecoveryCoordinator(store, provenanceClient, hostCapabilities)`. The existing session `AtomicRecordStore`, including host SQLite/IndexedDB adapters, satisfies the structural ciphertext interface. `prepare` returns `{record, broadcastPermit:true}` only after successful CAS.

## Flat examples

See [`examples/07-broadcaster`](examples/07-broadcaster/README.md) for local proof generation, public sidecars, verified Broadcaster quote/explicit submission and confirmed source publication.

## Normal Prepared integration

Configure `Invisi({ provenance: { client, manifest, prover, maxRootPages?, maxLeaves? }, ... })`. The client trust and authenticated manifest must be independently pinned; the local prover executes and verifies the source circuit. `prepared.withBroadcaster(client, { maxFeeAmount })` converges fees before building the final source witness, authenticating primary checkpoint anchors and replaying recognized trees locally. It sends the locally generated proof with the quote request. The Broadcaster submits source preflight and returns `provenanceTracking`; the SDK independently authenticates that record with a read-only source lookup before wallet authorization/main proving. The SDK does not submit source preflight on this route. The public evidence survives managed operation snapshots; clients/provers remain runtime capabilities.

After normal authorization and proving, call `ready.submitBroadcaster(client)`. It uses retained evidence automatically. `provenanceTracking()` returns a detached public tracking record. Credit lifecycle/draw and zero-private-input funding need no source proof. A source-gated relay with private inputs and missing source capabilities fails closed. The bounded replay defaults are 10 root pages and 100,000 total leaves; crossing the limit is explicit failure, never a per-Note network membership fallback.

Prepared contains the selected financial Note openings and full final native statement. Recognized-tree paths, signed certificates and a proving backend are additional runtime resources; callers do not manually assemble sidecars. Retry an externalized payment using its original ID/status; do not prepare a replacement while its outcome is uncertain.

## Optional relay and independent direct submission

Broadcaster use is explicit and optional. Each operator supports its own configured token set; transaction estimate rejection leaves the original Prepared unchanged and never silently selects another route. Direct wallet authorization, proof and transaction export do not depend on Broadcaster or Provenance availability.

| Route | Source submission | Protocol transaction |
|---|---|---|
| `withBroadcaster` | SDK proves locally; Broadcaster submits preflight and returns tracking in its quote | `submitBroadcaster` attaches retained evidence; the relay broadcasts |
| Direct, source first | App explicitly calls `evaluateTransaction(data, sidecars)` and retains tracking | App sends the unchanged protocol transaction independently |
| Direct, transaction first | After canonical confirmation, App explicitly calls `submitProof` with the actual operation locator | App sends the protocol transaction independently before source submission |

The App chooses the direct-step order. Source verification and recognition are always off-chain; no additional Provenance transaction is required. `RecoveryCoordinator` remains an optional explicit coordinator, not a prerequisite for direct transaction export.

## Concrete transaction quotes

`client.estimateQuote(data)` requests an unsigned estimate for this exact transaction shape. `client.quote(data, { chainId, protocol }, sidecars)` requests the verified firm quote. They use `broadcaster_estimateQuote` and `broadcaster_getQuote`, respectively, without a mode parameter; only the firm request submits Source preflight. `withBroadcaster` owns fee convergence and invokes the firm phase after final local source proving. `Protocol.getBroadcasters({ data })` probes each registered operator against the concrete transaction, including token support. Token-only probes and `getFee` are removed.

Only TypeScript is synchronized to this source release in this change. Go/Rust SDKs remain pending user confirmation; their prior artifacts/vectors are not claimed compatible with this manifest.

## Relay submission identity

`(await ready.submitBroadcaster(client)).id` is assigned only by the configured Broadcaster. The SDK does not compute or expose an ID generator, and does not assume a particular ID algorithm or hash format. No client-supplied idempotency key is sent to `broadcaster_submitTransaction`. Use the returned opaque ID with `broadcaster_getTransactionStatus`.

Before sending, the SDK retains the exact original calldata, quote and sidecars; managed Session persists the externalization fence. A lost first response is retried with that same body, letting the relay return the existing record. Once an ID is known it is saved for status-first recovery. The relay must never overwrite or send the accepted original request again. Runtime Source availability, spent inputs or expiry must not block replay of an already externalized original request; a previously unseen request still undergoes the relay's full validation. Source-proof job idempotency remains separate.
