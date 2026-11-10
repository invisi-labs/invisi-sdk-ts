# Optional Broadcaster and Provenance

| Example | Shows | Private Note source proof |
|---|---|---|
| `01-fee-query.ts` | Estimate a concrete Shield transaction; no signing or sending | No |
| `02-note-transfer.ts` | Final fee/quote → host approval → proof → relay submission | Yes |
| `03-credit-draw.ts` | Gross grant debit → fee deduction → net Note → relay submission | No |
| `04-note-withdrawal.ts` | One Note input, zero Note outputs, public withdrawal via relay | Yes |
| `05-shield.ts` | Public funding, fee quotation, funding signature and relay submission | No |
| `06-confirm-recognition.ts` | Primary receipt + automatic recognition for example02/04 | No new proof |
| `07-self-provenance.ts` | App has already sent a direct transaction; locally prove and submit to Provenance without a relay | Yes |

The criterion is **ordinary private Note inputs**, not commitments on both ends. A pure withdrawal still needs a source proof. Draw consumes and replaces Credit state commitments and produces a Note, so it needs no Note source proof; Provenance screens actual public payer funding. Create/update/revoke likewise do not require a Note source proof. Credit state commitments do not serve as recognized Note leaves.

## Configuration and execution

Copy `config.example.json` outside the repository and replace the public deployment, RPC, policy/provider/key and relay pins with trusted values. Set `EXAMPLE_CONFIG` to that file. `../settings.ts` selects the token, maximum fee and local main BB binary; `../accounts.ts` contains public wallet addresses. Keys, local decryption and authorization stay in the external native wallet host.

For source proving, sync authenticated assets with `python3 scripts/sync-provenance.py ../invisi-protocol`. `assetRoot` points at `.cache/provenance`, including nested artifact/VK paths. Set `INVISI_CRS_PATH` when local CRS configuration is needed. The input Note must already be recognized. Fee queries, draws and Shield do not need those assets.

```sh
export EXAMPLE_CONFIG='/outside/repository/broadcaster-config.json'
pnpm --filter @invisi-examples/scenarios example:broadcaster:1 --execute
pnpm --filter @invisi-examples/scenarios example:broadcaster:2 --execute
# To send through the relay, add --submit and use a new protected record path:
export PROVENANCE_RECORD='/outside/repository/payment-record.json'
pnpm --filter @invisi-examples/scenarios example:broadcaster:2 --execute --submit
export TRANSACTION_HASH='0x<canonical-confirmed-hash>'
pnpm --filter @invisi-examples/scenarios example:broadcaster:6 --execute
```

All scripts exit before configuration/network access unless `--execute` is present. `--submit` sends through the relay in02–05 and submits **only an offchain source proof** in07. Fees are token base units. The operator may support only some tokens; a fee rejection never silently chooses another route. Both requests use `broadcaster_getQuote` with concrete transaction data. `mode: "estimate"` returns an unsigned estimate with no Source submission; `mode: "firm"` verifies the final fee and Source proof and returns the signed quote/tracking. There is no token-only estimate or `getFee` endpoint.

In02/04, `withBroadcaster` converges the fee and generates the source proof locally. The relay submits source preflight and returns tracking; the SDK only reads/authenticates that tracking before approval. `submitBroadcaster` attaches retained evidence. The proof includes no uploaded opening or witness. Normal confirmation needs no second proof upload.

Example04 estimates the complete one-input/zero-output shape before choosing its exact withdrawal amount. If final pricing changes and leaves change, it stops before consent; it does not claim that a transaction with a change Note has zero outputs. Example03 keeps gross grant debits fixed; fees reduce the received Note and must leave a positive amount.

## Direct submission: independent steps

Run an ordinary direct Note transaction from `03-hidden-amount` using the host's own gas, and keep its transaction hash. Then run07:

```sh
export TRANSACTION_HASH='0x<your-self-broadcast-confirmed-transact>'
export PROVENANCE_RECORD='/outside/repository/direct-source-record.json'
pnpm --filter @invisi-examples/scenarios example:broadcaster:7 --execute --submit
```

This focused example supports exactly one Alice-owned private Note input, including a pure withdrawal. It reads actual canonical transaction/receipt data, discovers the spent input locally, reconstructs the native statement from the transaction, authenticates a recognized checkpoint against primary, proves K1 locally and explicitly calls `source.submitProof`. It never constructs or calls a Broadcaster client. Its default checkpoint is the latest; set optional `sourceRootId` in the copied config for an older physical tree containing the input. Replay is limited to100,000 leaves and discloses no per-Note membership interest.

A valid proof job may precede publication of the next recognized root; poll the same operation recognition without resending the main transaction.

The App chooses the order:07 demonstrates transaction first, proof after confirmation. For source first, the independent `evaluateTransaction(data, sidecars)` API admits tracking before the App broadcasts the unchanged transaction. Neither step automatically sends the other. Provenance verifies/recognizes offchain; there is no extra onchain proof transaction.

Records are exclusively created and synced before a network submission. Keep them private: tracking IDs are unlisted lookup capabilities. After a lost relay response, query the original broadcast ID. After a lost direct source response, reuse the exact saved `proofBundle`, locator and idempotency key with `submitProof`; do not regenerate a random proof under the old key. These flat examples do not replace a production encrypted operation journal.
