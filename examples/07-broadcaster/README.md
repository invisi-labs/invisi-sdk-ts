# Broadcaster and independent Provenance

| Example                       | Shows                                                                                                               |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `01-prepare-and-broadcast.ts` | Fee quote → wallet approval/main proof → local source proof from ready → relay validates and broadcasts             |
| `02-confirm-recognition.ts`   | Canonical primary receipt and automatic operation recognition                                                       |
| `03-self-provenance.ts`       | Direct payment; save its source proof, let the host send the main transaction, then explicitly submit to Provenance |
| `04-resubmit-provenance.ts`   | Restore a saved public proof packet and submit after confirmation without openings, proving assets or a Broadcaster |

Source proofs require ordinary private Note inputs, regardless of Note output count. A pure withdrawal needs one. Credit draw uses Credit state inputs, so it needs no Note source proof; the service screens its actual public payer funding. Create/update/revoke likewise need no Note source proof.

## Lifecycle

```ts
const quoted = await broadcaster.quote(prepared, { maxFeeAmount });
const authorization = await quoted.exportWalletAuthorization();
const signature = await signer.signTypedData(
    authorization.domain,
    authorization.types,
    authorization.message
);
const ready = await (await quoted.withWalletSignature(signature)).prove();
const sourceProof = await provenance.prove(ready); // Local data preparation + computation.
const submitted = await broadcaster.submit(ready); // Reuses the cached proof; server enforces Source before sending.
```

`quote` only converges the fee and obtains a signed quote. It makes no Source request and computes no source proof. `prove()` on the transaction produces the main protocol proof. `provenance.prove(ready)` fetches authenticated recognized-tree data and proves locally; it does not submit a proof to a service. The same `NativeProver` configured in `Invisi` also lets `broadcaster.submit(ready)` perform this step automatically when no cached proof exists.

For direct transactions, the App controls both independent steps:

```ts
const sourceProof = await provenance.prove(ready);
await provenance.submit(sourceProof); // Before or after independent host transaction submission.
```

The same API handles pre-submission and later delivery. Provenance verifies the proof, automatically matches an already confirmed payment or waits for one, then publishes recognition. The App need not provide a transaction hash; repeated delivery returns the same tracking record. A payment confirmed within its deadline remains eligible for later proof delivery. The SDK never sends or repeats the main transaction in this path.

## Local records and recovery

| Material                                         | Where to keep it                                               | Purpose                                                           |
| ------------------------------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| Local operation ID + transaction hash            | Transaction history                                            | Links history to the original operation and canonical transaction |
| Original plan and input Note openings            | Encrypted Session operation store, even after inputs are spent | Generate a proof later, or reprove after generation/root changes  |
| `ProvenanceProof` returned by `provenance.prove` | Persistent local record, preferably encrypted                  | Resubmit the exact proof without private openings or a prover     |
| Returned tracking ID and state               | App's local Source delivery record                             | Poll verification/recognition and reconcile pending work          |

A txHash, amount or commitment alone cannot recover a private opening. History entries already contain the original operation `id`; with managed Session, `session.resume(id)` retains the original input data independently of current Note inventory. Generate with `provenance.prove(restoredOperation)`. If the proof is already cached, this returns the stored packet without loading a prover. Keep this encrypted operation record until Source delivery/recovery is complete; deleting spent-input history must not delete the only remaining openings.

The public `ProvenanceProof` packet contains final calldata, deployment/token context, native circuit capacity/public statement, operation digest, source proof and root certificates. It contains no opening, nonce, witness, client or prover. It is JSON-serializable. Once saved, a fresh `Provenance()` can call `submit(savedProof)`; example04 shows that path. A generation change may require reproof, which still needs retained openings. A valid proof may precede root publication: poll `client.getTracking(id)` until recognized, never recreate the payment.

## Running

The same `NativeProver({bbBin, threads: 4})` instance handles main and Source proofs. Official Provenance is the default: no endpoint, provider ID, signing key, manifest parsing or `loadAssets` callback is needed. On first use, the SDK fetches identity over fixed official HTTPS, validates rotation signatures and pins trust within the instance. It independently checks the packaged Source release. Private deployments pass their explicitly trusted `provenanceClient` to `NativeProver`; `Provenance({prover})` inherits it.

Match `../settings.ts` for chain/token/RPC/BB. Authorization uses an ethers signer from `ALICE_PRIVATE_KEY`, matching Alice's public wallet owner. Note decryption remains in the App. Constructors do not access the network.

For native proving in a source checkout, sync authenticated packaged assets with `python3 scripts/sync-provenance.py ../invisi-protocol`. Set `INVISI_CRS_PATH` if needed. Cached-proof recovery in04 requires none of those assets.

```sh
pnpm --filter @invisi-examples/scenarios example:broadcaster:1 --execute
export TRANSACTION_HASH='0x<confirmed-hash>'
pnpm --filter @invisi-examples/scenarios example:broadcaster:2 --execute
pnpm --filter @invisi-examples/scenarios example:broadcaster:3 --execute
pnpm --filter @invisi-examples/scenarios example:broadcaster:4 --execute
```

Without `--execute`, each script exits before configuration/network access. Examples log records rather than writing files; the App must durably save the printed packet before sending. Relay submission IDs are opaque, assigned only by the service. An ID-less lost response retries the exact retained request; known IDs are queried first. Managed Session persists the externalization fence. Do not prepare a replacement payment while the original outcome is uncertain.

For explicit reproof, call `provenance.prove(restoredOperation, {reprove:true})` with current trusted roots and local proving capabilities. Retain/save the new returned packet. A frozen externalized relay request keeps its original proof/body; reproof does not replace it or send the main transaction again.
