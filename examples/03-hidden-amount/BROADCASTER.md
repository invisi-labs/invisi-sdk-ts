# Prepared payment → Broadcaster → automatic source recognition

The example follows the normal wallet flow: discover/decrypt Note → `prepareTransfer` → `withBroadcaster` → wallet authorization → main proof → `submitBroadcaster`. It does not accept prepared JSON, openings, public inputs or manually assembled sidecars.

## Configuration

- Copy `../broadcaster.example.json` outside the repository. Pin the deployment, policy, provider, active signing key and release independently. Configure matching primary and protocol RPC endpoints.
- Edit `../settings.ts` for the token, local main prover and maximum fee; `../accounts.ts` provides public wallet addresses. The native wallet transport retains the keys and decrypts locally.
- Sync source assets: `python3 scripts/sync-provenance.py ../invisi-protocol`. `assetRoot` is `.cache/provenance`, including nested artifact/VK paths. Supply local CRS resources when required.
- Fund Alice and wait for her input Note to be recognized. The example chooses one sufficiently large Note, sends half to Bob and creates change.

```sh
export PROVENANCE_CONFIG='/outside/repository/provenance-config.json'
export PROVENANCE_RECORD='/outside/repository/payment-source-record.json'
export INVISI_CRS_PATH='/path/to/public/bb-crs'
pnpm --filter @invisi-examples/scenarios example:hidden:7 --execute
# Add --submit to broadcast; use a new record path for each new payment.
export TRANSACTION_HASH='0x<confirmed-transaction-hash>'
pnpm --filter @invisi-examples/scenarios example:hidden:8 --execute
```

`withBroadcaster` settles the fee first, authenticates the source checkpoint against the primary chain, rebuilds recognized trees locally, proves the final statement and obtains tracked preflight plus the firm quote. Local source proving includes independent verification. K counts private inputs; the main circuit counts total input/output slots. No per-Note source membership query is sent.

`submitBroadcaster` automatically attaches retained evidence. Before submission, the example exclusively creates and syncs a protected record containing calldata, broadcast ID, tracking ID and operation digest. Tracking IDs are unlisted lookup capabilities; keep the file private. On timeout, retain the same payment and ID and query broadcaster status. Do not rerun payment preparation with another ID. Production applications should use the managed encrypted operation journal rather than this small public record.

The second example checks actual canonical primary calldata/receipt, waits for automatic tracking, and checks published recognition. Normal confirmation does not upload another proof. A reorg or stale generation requires reconciliation; missing tracking never selects a manual fallback. Explicit self-broadcast recovery remains available through `RecoveryCoordinator.prepareDirect` and `submitProof`.

The runtime supplies a pinned `ProvenanceClient`, authenticated manifest and local source prover. Prepared already holds financial Note openings and the final native statement; it obtains recognized-tree paths/certificates automatically. Runtime clients/provers are not serialized. Managed operation snapshots retain public evidence and tracking, with input reservations preserved on uncertain submission.

Credit uses [`../04-credit/05-draw-via-broadcaster.ts`](../04-credit/05-draw-via-broadcaster.ts): prepare draw → `withBroadcaster` → wallet authorization → main proof → `submitBroadcaster`. It has no private Note inputs, so no source proof is needed; source screening checks actual public funding after confirmation. Gross grant usage includes the fee and the output Note receives the net amount. Use the same public relay configuration and protected record path.
