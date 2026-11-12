# TypeScript examples

Each named scenario is a flat, independent script. Authorization signatures use ethers EIP-712 signing. Supply the corresponding account key through `ALICE_PRIVATE_KEY`, `BOB_PRIVATE_KEY`, or `CHARLIE_PRIVATE_KEY`; Session examples use `<SESSION_ACCOUNT in uppercase>_PRIVATE_KEY`. Each signer is checked against the required owner or payer. Keep private keys out of `accounts/accounts.json`. Viewing keys, detection keys, and Note/Credit decryption belong to the App. Configure its explicit callbacks in `app-decryptor.ts` before running decryption examples. Only the offline Note output example runs without `--execute`. The Broadcaster and self-provenance submission examples submit as part of their `--execute` flow.

## Setup

```sh
pnpm install
pnpm build
pnpm examples
mkdir -p examples/accounts
cp examples/accounts.example.json examples/accounts/accounts.json
```

Fill the copied file with public EVM addresses and complete public `0i` receiving addresses. `accounts.ts` rejects additional fields. Edit `settings.ts` for your chain RPC, trusted Protocol RPC, token, and Barretenberg 6.0.0 binary. A historical-state chain RPC is required for independent verification. Shield and cash examples read ERC20 decimals for their token amounts; financial arithmetic uses integers throughout. Credit limits and draws are explicit token base units.

```sh
pnpm --filter @invisi-examples/scenarios example:hidden:3 --execute
```

Without `--execute`, live scripts exit before reading account configuration, environment inputs, opening databases, or connecting to RPC. Running with it can read sensitive note openings and persist encrypted wallet state, but existing Note/Credit scenarios never submit a transaction.

## Public Wallet initialization

Initialize the public wallet from the App's complete receiving address:

```ts
// Wallet requires complete 0i receiving material; use ownerAddress directly for identity-only operations.
const wallet = Wallet.fromAddress(receivingAddress);
```

The App owns account selection, key storage, unlocking and public-profile lookup. The SDK does not provide a native module or a JSON bridge.

## Host request and response boundaries

Authorization examples call `exportWalletAuthorization()`, sign its exact `domain`, `types`, and `message` with ethers `signTypedData()`, then attach the signature through `withWalletSignature()`. They do not export native signing requests or match signing responses by ID. Final Broadcaster quotes must be accepted before signing.

Decryption is explicitly injected through `DeliveryDecryptor`. Implement the two callbacks in `app-decryptor.ts` using your App's wallet. They receive ciphertext and the complete owner/deployment/token/commitment context, plus the Credit delivery role. Return authenticated delivery bytes, explicit `null` only for a known nonrecipient, or `{ status: "authentication-failed" }` when AEAD failure is ambiguous. Optional native batch detection also receives clues. Throw on locked accounts, expired sessions, cancellation and other operational errors.

`authenticatedDecryptor(ownerAddress, decryptor, receivingKeys)` decodes and checks returned plaintext against the requested owner, token, commitment and Credit receiving key. Discovery independently checks canonical receipt evidence. Session uses `await pending.decrypt(decryptor)` to commit each authenticated batch and its account checkpoint atomically; failed batches do not advance the cursor, and earlier commits remain. Ambiguous candidates are retained for `retryUnresolved` and asset completeness remains unknown. See [shared public history](../packages/session/README.md#shared-public-history). No request IDs, response matching, native transport or private keys are needed in SDK configuration.

`example-io.ts` only formats log output and reads public recovery records; it performs no wallet operation.

Funding and address registration use separate EIP-712 authorizations, also signed directly with ethers. Funding signatures bind the finalized funding request; hidden-amount transactions are proved before exporting that request. The SDK checks signatures when attaching them. Caller-funded transactions require submission by their specified payer. Token balances, ERC20 allowance, gas, and normal transaction submission remain application responsibilities.

The normal payment examples export unsigned transactions for host review/submission. `07-broadcaster` separately demonstrates fee queries, signed final quotes, relay submission and independent offchain source submission. With `--execute`, example01 relays the main transaction; example02 submits its source proof and queries recognition. Example02 `--resume` reuses a saved proof without preparing another transaction.

The App decryptor must authenticate the ciphertext (including the AEAD tag) before returning plaintext. Commitment checks validate financial contents; they do not independently authenticate opaque memo bytes.

## Scenarios

- `01-address-registry`: initial registration and update, with external EVM authorization.
- `02-transparent-amount`: offline Note output construction, shield one or nine outputs, registered-address lookup, explicit chain lookup, external funding signature, and memo.
- `03-hidden-amount`: cash plus change, notes plus cash, three recipients, full owner withdrawal, partial public withdrawal plus private output/change, third-party owner sweep, and four-member two-party aggregation. Full owner sweeps require proof but no private spending authorization. Other transfers request authorization when their prepared preview requires it.
- `04-credit`: independent owner grants, batch draws, current-state policy/balance update, and public owner revocation. Principal remains with the owner until draw.
- `05-wallet-session`: encrypted SQLite restoration, explicit refresh batches, persisted Note and Credit preparation, grant reservations, and operation reconciliation. There is no injected private executor or automatic signer.
- `07-broadcaster`: concrete-transaction estimation, one common prepare/quote/relay submission flow, tracking confirmation and self-submitted source proofs. Both use Session inventory discovery and automatic selection.
- `06-disclosure`: independently read canonical receipt evidence, invoke App decryption, validate the returned opening, and verify a transferable disclosure. The memo example decodes the App-authenticated application payload without claiming its financial opening proves the memo.

## Automatic discovery and recovery

Note and Credit examples discover outputs automatically through the configured Protocol RPC. You do not supply plaintext note input JSON. `discover-candidates.ts` and `discover-credits.ts` paginate indexed history, invoke the injected decryptor, validate plaintext and check the independent canonical receipt. They reject conflicting indexed rows and propagate operational errors; only explicit `null` is a known nonrecipient. Ambiguous authentication failures remain unresolved. Indexed nullifiers and Credit revocation bitmaps filter current inventory; preparation independently checks current on-chain membership and eligibility again.

Selection and amount calculations remain visible in each scenario. The cash-only examples create their own outputs; later note scenarios discover those receipts after host submission and indexing. Aggregation discovers each participant's notes separately, requests their authorization separately, and combines only their public proved aggregate members. Credit revocation discovers a current owner grant and uses its public revocation location.

Disclosure examples discover historical outputs, including spent notes or consumed grants, and use canonical receipt evidence before exporting financial openings. The memo example decodes the host-authenticated application payload and explicitly states that a financial opening does not prove memo bytes to a third party. The injected interface returns plaintext, not a payload decryption key; examples never reconstruct a viewing key. Openings do not establish payer identity or current unspent status.

Session examples require Node.js 22.13+ and `STORE_ENCRYPTION_KEY_HEX`, a dedicated external 32-byte storage encryption key, plus optional `WALLET_DB` (default `examples/accounts/alice-session.sqlite`, resolved independently of the working directory). This key is solely for the encrypted store and must be supplied by host key management independently of account material. Use the same key, path, and namespace when restoring. Refresh remains visibly two steps: stage through `session.refresh(...)`, then validate and commit through `pending.decrypt(decryptor)`. The restore example persists the shared public cache, catches up recent pages before historical gaps, and prints independent scan status and spendability. It pages history rather than loading all lifetime records. Keep exported operation IDs so a host can reconcile an existing submission rather than create a second payment.

After external submission, recovery optionally reads `HOST_TRANSACTIONS_JSON`, an object mapping persisted operation IDs to host transaction hashes. It attaches these hashes with `trackTransaction` and reconciles canonical receipts without resending or signing again.

## Managed Credit walkthrough

The Session supports `prepareCreateCredit`, `prepareDrawCredit`, `prepareUpdateCredit`, and `prepareRevokeCredit`. It persists their intents and reservations, refreshes both role deliveries, and resumes them through the same operation API as Note payments. Credit quota is not included in the ordinary Note balance. The stateless `04-credit` files remain useful when the caller owns inventory management.

Run each command with `--execute` after configuring the public accounts and external storage key:

| Script              | Account                                               | What it demonstrates                                                                                                                |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `example:session:5` | Bob by default; repeat with `SESSION_ACCOUNT=charlie` | Create a finite grant to Alice without spending Notes or moving principal                                                           |
| `example:session:6` | Alice by default                                      | Refresh durable spender inventory, draw seven base units from each of two different payers, issue one ordinary 14-unit Note to Dave |
| `example:session:7` | Bob by default                                        | Select a finite owner grant and add 100 base units to remaining quota, preserving usage                                             |
| `example:session:8` | Bob by default                                        | Select a public grant reference and export owner-submitted revocation without private authorization or proof                        |
| `example:session:4` | `SESSION_ACCOUNT` (Alice by default)                  | Resume and canonically reconcile existing Note or Credit operations by their saved IDs                                              |

```sh
pnpm --filter @invisi-examples/scenarios example:session:5 --execute
SESSION_ACCOUNT=charlie pnpm --filter @invisi-examples/scenarios example:session:5 --execute
pnpm --filter @invisi-examples/scenarios example:session:6 --execute
SESSION_ACCOUNT=bob pnpm --filter @invisi-examples/scenarios example:session:7 --execute
SESSION_ACCOUNT=bob pnpm --filter @invisi-examples/scenarios example:session:8 --execute
```

Submit and confirm each exported transaction through the host before running a dependent step. Bob and Charlie must each supply ERC20 allowance and balance before Alice's draw. Refresh discovers the submitted successor grants automatically; the draw's recipient may be any complete receiving address. Its output is an ordinary Note, discovered by Dave's Session and spent through the normal Note flow.

Each main visibly opens the encrypted store, refreshes through the injected App decryptor, selects role-bound Credit state, prepares the managed operation, and exports unsigned calldata. The store snapshot supplies current grant references; Session preparation independently rechecks chain state and reserves the consumed grant across both roles. No second ephemeral discovery scan is needed. Amounts are token base units; these examples use zero fees.

The account controls the default database (`examples/accounts/<account>-session.sqlite`) and namespace (`<account>-local-experiments`). A `WALLET_DB` override is supported. Use the same account, namespace, database and host storage key for recovery. Set `HOST_TRANSACTIONS_JSON` to map saved operation IDs to the host-submitted transaction hashes, then run `example:session:4`. Exported operations remain reserved until canonical reconciliation: do not recreate a draw after a timeout or expect creating/updating a grant to credit your Note balance.

## Provenance

Before running native Source proof examples from this checkout, run `python3 scripts/sync-provenance.py ../invisi-protocol` from the SDK repository root. This provisions `packages/prover/provenance`, which `NativeProver` loads by default. If you use `--output <asset-root>`, supply the same root as `provenanceAssetsPath` in `NativeProver`; the authenticated manifest and all seven circuit tiers must match the current protocol release.

[Broadcaster and independent Provenance examples](07-broadcaster/) demonstrate relay fees/submission and direct source submission separately. A Note input requires source proof even without a Note output; Credit state inputs do not require a Note source proof.

Run `example:broadcaster:1 --execute` to discover `clients` by token, select one, then quote and relay the payment. No service credentials or Source policy are entered manually.

The same example follows the quote's signed `execution` automatically: cold-period `direct` quotes produce EVM proofs, while `aggregate` quotes produce recursive members that the service batches or wraps singly. No manual route or sidecar construction is needed. `queued`/`proving` require service-status polling and later canonical wallet reconciliation; they do not mean that the payment is confirmed.

| Command | Order and recovery |
| --- | --- |
| `example:broadcaster:2 --execute` | Generate and submit Source proof first; send the main payment only after acceptance |
| `example:broadcaster:3 --execute` | Encrypt original operation/openings in SQLite, then send the main payment without Provenance access |
| `example:broadcaster:3 --execute --resume` | Reopen the same journal by `OPERATION_ID`, reconcile confirmation, fetch recognition data, generate Source proof and submit |

Example03 requires `STORE_ENCRYPTION_KEY_HEX`, a dedicated 32-byte storage key retained across runs. `WALLET_DB` optionally overrides `examples/accounts/alice-provenance.sqlite`. Save the operation ID printed before sending, then set `OPERATION_ID` for `--resume`. A crash between sending and journaling the hash can be reconciled with optional `TRANSACTION_HASH`; it is not passed to Provenance. Recovery needs neither `ALICE_PRIVATE_KEY` nor a previously generated Source proof, and never signs or sends a payment. If Source is offline or input recognition is pending, retry the same operation after data becomes available. Keep the encrypted original operation even after spent inventory is pruned.

Examples01/02 use ephemeral inventory; Example03 demonstrates encrypted persistent operation recovery. None serializes a `ready` object or stores openings in public history.

Gas estimation: the Note funding, four Credit and Broadcaster examples call `prepared.estimateGas()` before authorization or proving. This local receipt-calibrated preview does not check approval or chain state. All valid direct shapes return positive `gasUnits`; `source` is always `benchmark`; `statistic` distinguishes measured medians from calibrated estimates, and `protocolCommit` identifies calibration. Recursive aggregate previews remain unsupported. Example 07-02 demonstrates optional final RPC simulation performed directly by the App provider, then passes its gas budget to `session.sendTransaction`. Current fee prices, safety margins and approval remain host decisions.
