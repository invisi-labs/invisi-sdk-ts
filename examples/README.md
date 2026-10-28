# SDK examples

Read the numbered folders in order. Business walkthroughs use direct `Invisi.prepare...` calls and application-selected inputs. They show local review, authorization, proof generation and public calldata export without a Store or WalletSession. The final topic introduces managed wallet state separately.

| Topic | Walkthroughs |
| --- | --- |
| [00-wallet](00-wallet/index.ts) | Offline wallet, addresses, viewing and detection capabilities. Run `wallet`. |
| [01-connect](01-connect/index.ts) | Chain RPC, Protocol RPC and deployment verification. Run `connect`, `chains` or `connect-custom`. |
| [02-shield](02-shield/index.ts) | Public ERC20 approval and shield; [permit](02-shield/permit.ts) shows EIP2612. Run `shield` or `shield-permit`. |
| [03-funds](03-funds/transfer.ts) | `transfer`, `withdraw`, `mixed-funding`, `public-split` and whole-note `sweep`. |
| [04-credit](04-credit/create.ts) | `credit-create`, `credit-draw`, `credit-top-up` and `credit-cancel`. |
| [05-registry](05-registry/register.ts) | Independent receiving-key registration and update. Run `registry` or `registry-update`. |
| [06-aggregation](06-aggregation/index.ts) | Four independent recursive members and one public aggregate call. Run `aggregate`. |
| [07-disclosure](07-disclosure/index.ts) | Scoped offline disclosure and read-only receipt verification. Run `disclosure` or `disclosure-chain`. |
| [08-wallet-session](08-wallet-session/index.ts) | Encrypted storage, inventory refresh, automatic input selection, reservations and persistent operation recovery. Run `session`, `session-transfer`, `refresh` or `recover`. |

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm examples --list
pnpm examples wallet
pnpm examples disclosure
```

Examples are walkthroughs. Build and typecheck validate their API usage; cryptographic and lifecycle tests belong to the SDK packages. Offline smoke runs do not establish live deployment acceptance.

## Connections and local capabilities

Each chain example constructs its provider, Protocol RPC client and Protocol explicitly:

```ts
const provider = new JsonRpcProvider(required("CHAIN_RPC_URL"));
const protocolRpc = new ProtocolRpcClient(required("PROTOCOL_RPC_URL"));
const protocol = await Protocol.fromRpc(protocolRpc, provider);
const invisi = new Invisi({ provider, protocolRpc, prover: new NativeProver() });
```

`Protocol.fromRpc` selects the provider's chain and verifies deployed bytecode and protocol version. Choose a trusted service; consistency checks do not establish official provenance. `connect-custom` loads a trusted team record from `INVISI_DEPLOYMENT_FILE`. The `chains` command lists supported chains and their indexed status.

Chain RPC supplies canonical blocks, receipts, contract reads and transaction submission. Protocol RPC supplies public history, candidates and authenticated paths. Private inputs, signing and proof generation stay local. `new NativeProver()` uses BB6.0.0 from PATH and defaults to four threads; set `bbBin` only for a custom executable path. Shield, connection and disclosure do not require a prover.

Only capability-specific settings are needed:

| Variable | Used for |
| --- | --- |
| `CHAIN_RPC_URL` | Chain RPC endpoint, such as `http://127.0.0.1:8545`. |
| `PROTOCOL_RPC_URL` | Protocol RPC service, such as `http://127.0.0.1:8080/v1`. |
| `WALLET_ACCOUNT_PRIVATE_KEY` | Locally restored Invisi wallet. Not needed by the public-only sweep or deployment-only examples. |
| `FUNDING_PRIVATE_KEY` | Optional separate public funding account; funding examples otherwise use the wallet account key. |
| `WALLET_STORAGE_KEY` | AES key for the encrypted database in `08-wallet-session` only. |

Token addresses, amounts and file paths are visible constants. Change them for your deployment. Funding examples can submit an ERC20 approval; shield, registry and managed-session examples also submit their prepared operations. Ordinary funds, Credit and aggregate walkthroughs stop at exported public calldata. No generic transaction client is implemented by the SDK: submit exported calls through ethers in the host application.

Managed and registry operations also export calls for ethers. They associate the returned hash with `trackTransaction(transaction.hash)` and run `reconcile()` after `transaction.wait()`. Operations have no SDK `submit()` or `wait()` method. `WalletSession.sendTransaction(ready)` is a thin alternative: it exports a managed operation, calls the injected ethers signer, records the hash and returns the native ethers response. `sendTransaction(call, options)` forwards a plain call without associating an operation. Cancellation can stop local SDK work; ethers sending and receipt waiting follow the application's own lifecycle. For hash persistence before broadcast, sign the populated request with ethers, track its keccak256 hash, then broadcast its signed bytes. A receipt or replacement returned by ethers is independently verified during reconciliation.

The command-line runner owns resource cleanup through `resources.defer()`. Examples immediately register provider/database cleanup. Framework integrations manage their own lifecycle.

## Direct inputs

Business examples construct `NoteInput` and `CreditInput` directly in TypeScript. No private input JSON file or storage adapter is needed to read the walkthroughs.

A funds input has two parts:

- `note`: the original private fields — chain, Protocol, wallet identity, token, amount and nonce.
- `commitment`, `treeId`, `leafIndex`: the matching commitment and its canonical insertion position.

The examples explicitly compute the randomized note identity and commitment from those private fields, then build the input object:

```ts
const identity = await computeNoteIdentity(BigInt(note.walletIdentity), note.nonce);
const commitment = await computeNoteCommitment(note.chainId, identity, note.tokenAddress, note.amount);
const inputs: NoteInput[] = [{ note, commitment, treeId: 1n, leafIndex: 0 }];
```

The inline amounts, nonces and positions are illustrative. Before running a private spend, replace them with an actual received note's fields and canonical insertion position. Preserve the original nonce; recomputing a commitment does not insert a note or create spendable funds. The SDK checks membership and spent state against the selected deployment.

Credit examples also show the full `CreditDeliveryState`, both historical receiving-key snapshots, shared-key hash, commitment computation and role-scoped `CreditInput`. Draw uses `spender`; cancel/top-up use `owner`. Preserve the Credit's original keys after wallet key rotation. Top-up extends the existing expiry and must run before it expires; cancellation is also allowed after expiry.

Aggregation constructs four independent input groups explicitly. Its sample positions and nonces must likewise be replaced with real received records. Applications select and reserve these records in their own storage before preparation.

The direct pipeline is:

```ts
const prepared = await invisi.prepareTransfer({ wallet, protocol, tokenAddress, inputs, outputs });
console.log(prepared.preview()); // Local review before granting authorization.
const authorized = await prepared.authorize();
const proved = await authorized.prove({
    onProgress(event) { console.log(event.phase); },
});
const call = await proved.exportTransaction();
```

The SDK verifies input deployment, owner/role, commitment, spent state and membership. All supplied funds inputs are used and any excess becomes independently randomized change. Use `inputs: []` for public-only splitting. Sweep accepts complete notes with a public wallet alone and pays their full value to the bound owner without an owner signature. Credit draws/cancellations also pay their immutable public payout addresses. Recursive members must use disjoint inputs; aggregation checks the groups before proving.

The host application owns input reservations, operation records, submission and inventory updates. Persist the exact signed EVM transaction hash before broadcasting, authenticate its canonical receipt and retain reservations across uncertain outcomes. Exporting a proof does not consume inputs, and a timeout does not revoke it. The simple business examples intentionally do not implement a persistence or broadcast subsystem.

## WalletSession

Use a session when the SDK should manage owned inventory and operation persistence:

- [index.ts](08-wallet-session/index.ts), `session`: construct an encrypted SQLite store, connect a wallet, refresh and inspect known funds.
- [transfer.ts](08-wallet-session/transfer.ts), `session-transfer`: automatic input selection and reservation, local authorization/proof, session-delegated ethers submission and independent protocol reconciliation.
- [refresh.ts](08-wallet-session/refresh.ts), `refresh`: continue from an authenticated checkpoint; optional explicit FMD delegation.
- [recovery.ts](08-wallet-session/recovery.ts), `recover`: reopen operations, reconcile uncertain submissions and rebuild invalidated inventory.
- [browser.ts](08-wallet-session/browser.ts): IndexedDB and local WASM proving. [react.tsx](08-wallet-session/react.tsx) and [vue.ts](08-wallet-session/vue.ts) add local review and cancellation callbacks.

SQLite requires Node22.13 or newer. The host owns its storage key, database connection and application namespace. A complete wallet supplies viewing and authorization capabilities; the managed transfer also demonstrates explicit delegation. Session balances summarize locally known notes, not public ERC20 balances or Protocol holdings.

Refresh consumes Protocol RPC candidates, authenticates complete receipts through Chain RPC, decrypts locally and checks owned membership and nullifiers. Select explicit history ranges; use `reset` only for invalidated history. Neither filtered candidates nor checkpoints prove complete history. FMD delegation is explicit and does not grant decryption or spending permission. Canceling local work cannot revoke an exported proof or broadcast transaction.

For browser proving, serve Noir WASM and BB workers as bundler assets and configure COOP `same-origin` plus COEP `require-corp`. Preserve historical viewing keys after external key rotation. Application unlock, review and UI flows remain application responsibilities.

## Local deployment

```sh
anvil --chain-id 31337
# In a second terminal, from this repository:
pnpm deploy:local
pnpm build
```

Use a fresh Anvil chain. The script deploys a multi-token Protocol, two seeded tokens and an independent receiving-key registry, then records/verifies `../invisi-protocol/deployment/deployment.json`. `INVISI_PROTOCOL_DIR` selects another protocol checkout; `INVISI_DEPLOYMENT_CATALOG` selects a different catalog path. Local verifiers are mocks for integration only. Real assets require authenticated real verifiers and private keys.

Invisi defines no mnemonic or HD path. `00-wallet` uses ethers to obtain an account key and then derives Invisi capabilities from it. Public browser wallet connections expose addresses/signing requests rather than private keys; application-owned account-key access is a distinct integration choice.
