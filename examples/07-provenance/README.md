# Provenance: one private input → Broadcaster → source recognition

The two files show the calls in order; there is no shared scenario runtime. They use a **real, already prepared direct `transact` with exactly one private Note input**. Its main circuit can have more than one slot (for example C2: one input, one output); its independent source proof uses K1. No aggregate, Credit-state leaf, remote witness/prover or account key is involved.

## Before running

1. Prepare/authorize/prove the main transaction through the normal Note flow. Discover and decrypt its selected Note locally through the existing host boundary. Settle the broadcaster fee **before** freezing the main statement: initial `getFee` needs no source proof. Retain the exact main `publicInputs` and final calldata; the source proof binds this statement. A changed fee, output, deadline or input requires rebuilding the main proof and source proof, then obtaining a new quote.
2. Copy `config.example.json` outside the repository and replace every placeholder with externally trusted deployment, policy, provider and **active** signing-key pins. Do not take trust pins from an untrusted API response. This short example pins one key; production key rotation uses the verified history APIs described in `../../PROVENANCE.md`.
3. Synchronize authenticated local source assets with `python3 scripts/sync-provenance.py ../invisi-protocol`. `assetRoot` points at `.cache/provenance`, including its nested `circuits/provenance` paths. Supply local SRS/runtime resources as required by the proving backend.
4. Have the host pass this local JSON through stdin. All integers are strings. `rootId` identifies a currently usable signed checkpoint containing the selected Note. The source tree is replayed locally; no per-Note membership request discloses interest to the source API.

```json
{
  "rootId": "1:2",
  "tokenAddress": "0x<20-byte-token-address>",
  "opening": {"owner": "0x<owner>", "nonce": "<private-field-integer>", "amount": "<base-units>"},
  "mainCircuitCapacity": "2",
  "publicInputs": ["<exact main-proof public fields, including authorization limbs>"],
  "data": "0x<final proved and authorized transact calldata>"
}
```

This is a **host-local handoff**, not a Provenance request schema. Never upload it, log it or commit it. The normal host should retain openings in encrypted storage and feed stdin directly; the shell commands below use an external protected file only to make the CLI boundary visible. The SDK independently authenticates the release, source certificate, root replay and proof. The example checks the primary chain/checkpoint anchor and that the main statement spends the supplied Note; the Broadcaster additionally validates the binding against the submitted calldata.

```sh
export PROVENANCE_CONFIG='/outside/repository/provenance-config.json'
export PROVENANCE_RECORD='/outside/repository/payment-source-public.json'
export BROADCAST_ID='stable-host-operation-id'
```

The public record contains only calldata, sidecar, quote and stable IDs. It is created exclusively and synced **before** submission; an existing file aborts instead of overwriting an uncertain payment. This is not a substitute for a production encrypted wallet/recovery journal. See `RecoveryCoordinator` in `../../PROVENANCE.md` for durable host integration.

## Run

```sh
# Node.js local WASM proving, independent verification; configure local CRS if needed.
export INVISI_CRS_PATH='/path/to/public/bb-crs'
pnpm --filter @invisi-examples/scenarios example:provenance:1 --execute < /protected/host-prepared.json
# Add --submit to that first invocation to really broadcast (start with a new record path).
export TRANSACTION_HASH='0x<confirmed-transaction-hash>'
pnpm --filter @invisi-examples/scenarios example:provenance:2 --execute
```

Retain main public fields from `transactUserPublicInputs(context, params, deliveries, funding)` (`@invisi-labs/protocol`) for the exact prepared main request. Local `exportSidecar` calls `LocalProvenanceProver`; that class executes Noir and BB WASM and independently verifies its output.

The first command proves locally and obtains a cryptographically verified, required-policy-bound quote. It does not broadcast unless `--submit` is present. Review the configured recipient, final fee-bearing calldata and intent before using that switch. The example stores the public record and prints Broadcaster status, which may still be pending; it never treats HTTP acceptance as chain confirmation.

For a quote timeout, failed submit response or restart, retain the **same** calldata, sidecar, quote and `BROADCAST_ID`. Query the Broadcaster's `status` API using that ID. Retry the identical submission only through the original host/recovery journal; do not run the first example again with a new ID or change the fee to bypass an uncertain submission. For confirmed or independently submitted transactions, run the second example directly with their transaction hash and original public record.

The second command reads the actual primary transaction, successful receipt and canonical block, checks deployment/calldata, submits the source proof, then waits for the proof job and **separately** for the operation's published `recognitionState`. `valid` is not `recognized`. Index lag, insufficient confirmations or publication delay can require rerunning this second command with the same record/hash. A reorg or `stale_generation` requires host reconciliation and explicit local reproof; it never resends the payment. A recipient separately authenticates the signed published root/anchor and its Note membership; this operation-status query does not replace that verification.

Only public evidence is sent to Provenance and Broadcaster. No service receives `opening`, nonce, witness, viewing key or private key. These examples perform no approval, EVM signing or automatic repricing.
