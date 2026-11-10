# Optional Broadcaster and Provenance

| Example | Shows |
|---|---|
| `01-prepare-and-broadcast.ts` | One Note transfer: prepare → fee/quote and source proof → host approval → main proof → relay submission |
| `02-confirm-recognition.ts` | Verify the primary receipt and wait for automatic source recognition |
| `03-self-provenance.ts` | Submit a source proof independently after the App has sent its own transaction |

This category demonstrates the common Broadcaster workflow with one Note transfer. Other transaction preparation scenarios remain in `02-transparent-amount`, `03-hidden-amount` and `04-credit`; there is no scenario switch here.

The criterion is **ordinary private Note inputs**, not commitments on both ends. A pure withdrawal still needs a source proof. Draw consumes and replaces Credit state commitments and produces a Note, so it needs no Note source proof; Provenance screens actual public payer funding. Create/update/revoke likewise do not require a Note source proof. Credit state commitments do not serve as recognized Note leaves.

## Configuration and execution

The official network uses one logical recognition service, defaulting to `https://provenance.invisipay.fi` (`DEFAULT_PROVENANCE_ENDPOINT`). Replicas share the same authority and recognition state; chain/protocol instances still have separate trees. For a private deployment, edit `provenanceEndpoint` and its matching trust pins at the top of each script.

All configuration is written directly in each script. Replace the protocol/provider/signing-key placeholders; in01, also replace the relay endpoint, quote signer and fee recipient. `../settings.ts` supplies the chain/RPC endpoints, token, maximum fee and local main BB binary. `../accounts.ts` contains public wallet addresses. Keys, local decryption and authorization stay in the external native wallet host. No external configuration file is needed.

For source proving, sync authenticated assets with `python3 scripts/sync-provenance.py ../invisi-protocol`. Each script resolves `assetRoot` to the SDK repository's `.cache/provenance`, including nested artifact/VK paths. Set `INVISI_CRS_PATH` when local CRS configuration is needed. The input Note must already be recognized.

```sh
pnpm --filter @invisi-examples/scenarios example:broadcaster:1 --execute
export TRANSACTION_HASH='0x<canonical-confirmed-hash>'
pnpm --filter @invisi-examples/scenarios example:broadcaster:2 --execute
```

All scripts exit before configuration/network access unless `--execute` is present. With `--execute`, example01 sends through the relay and example03 submits **only an offchain source proof**. Fees are token base units. The operator may support only some tokens; a fee rejection never silently chooses another route. `broadcaster_estimateQuote` requires concrete transaction data and returns an unsigned estimate without Source submission. `broadcaster_getQuote` validates the final fee and Source proof and returns the signed quote/tracking. Both steps are automatic inside `broadcaster.quote`; there is no `mode` argument. There is no token-only estimate or `getFee` endpoint.

In01, `broadcaster.quote` converges the fee and generates the source proof locally. The relay submits source preflight and returns tracking; the SDK only reads/authenticates that tracking before approval. `broadcaster.submit` attaches retained evidence. The proof includes no uploaded opening or witness. Normal confirmation needs no second proof upload.

## Direct submission: independent steps

Run an ordinary direct Note transaction from `03-hidden-amount` using the host's own gas, and keep its transaction hash. Then run03:

```sh
export TRANSACTION_HASH='0x<your-self-broadcast-confirmed-transact>'
pnpm --filter @invisi-examples/scenarios example:broadcaster:3 --execute
```

This focused example supports exactly one Alice-owned private Note input, including a pure withdrawal. It reads actual canonical transaction/receipt data, discovers the spent input locally, reconstructs the native statement from the transaction, authenticates a recognized checkpoint against primary, proves K1 locally and explicitly calls `source.submitProof`. It never constructs or calls a Broadcaster client. Its default checkpoint is the latest; edit optional `sourceRootId` at the top of the script for an older physical tree containing the input. Replay is limited to100,000 leaves and discloses no per-Note membership interest.

A valid proof job may precede publication of the next recognized root; poll the same operation recognition without resending the main transaction.

The App chooses the order:03 demonstrates transaction first, proof after confirmation. For source first, the independent `evaluateTransaction(data, sidecars)` API admits tracking before the App broadcasts the unchanged transaction. Neither step automatically sends the other. Provenance verifies/recognizes offchain; there is no extra onchain proof transaction.

Examples print records with `console.log`; they do not write record files. Paste the Broadcast record printed by01 into02 when prompted. Keep tracking IDs private: they are unlisted lookup capabilities. For an uncertain relay response before an ID was returned, retry the same retained operation; if an ID was returned, query it. For an uncertain source response, reuse the exact printed `proofBundle`, locator and idempotency key; do not regenerate a random proof under the same key.

For an explicit estimate of an already prepared transaction:

```ts
const estimate = await client.estimateQuote((await prepared.exportBroadcasterIntent()).data);
```

This does not freeze a fee or sign a quote. Normal applications simply call `broadcaster.quote`, which performs estimation, fee convergence, source proving and the final `getQuote` request.

## Service-owned submission identity

```ts
const submitted = await client.submit(ready);
console.log(submitted.id);
const status = await client.status(submitted.id);
```

The SDK treats `id` as an opaque Broadcaster-owned string. It does not compute it or assume a hash format; operators may define different ID algorithms. The configured Broadcaster alone recognizes identical requests and returns their existing record without replacing or sending the transaction again.

The SDK retains the original transaction, quote and sidecars before sending; managed Session persists its externalization fence. If the first response/ID is lost, retry the same prepared operation to resend the exact retained request. Once the returned ID is saved, subsequent retries query it first. Do not prepare a replacement payment after an uncertain response. Source `submitProof` still has its own proof-job idempotency key, independently of relay IDs.

## Application flow

```ts
const quoted = await broadcaster.quote(prepared, { maxFeeAmount });
const ready = await (await quoted.withWalletResponse(response)).prove();
const submitted = await broadcaster.submit(ready);
const status = await broadcaster.status(submitted.id);
```

The transaction still owns approval/proving. Broadcaster owns estimation, signed quotation, submission and status. Managed Session uses the same calls and retains its existing encrypted persistence, reservations and retry behavior. Advanced raw-calldata integrations use `estimateQuote`, `getQuote` and `submitTransaction`; they do not replace the normal object flow.
