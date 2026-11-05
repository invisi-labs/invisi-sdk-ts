# Invisi SDK examples

Flat, independently readable TypeScript examples using the public SDK and ethers. Comments, logs and documentation are English. Business examples use external signing requests; only category 05 imports `@invisi-labs/session` for WalletSession and a persistent Store. Stateless examples import `@invisi-labs/sdk` without session or storage dependencies.

## Setup

From the workspace root:

```sh
pnpm install
pnpm build
pnpm examples wallet
```

`wallet` is entirely offline and uses a public test mnemonic. Never fund its accounts. On-chain examples require Node.js 22.13 or newer for `node:sqlite`, a funded EVM testnet, and a matching deployed protocol. Chain 97 is the verified default, not a restriction.

### Customize connections and token

Edit [settings.ts](settings.ts):

- `chainRpcUrl`: your Ethereum JSON-RPC endpoint with historical state access.
- `protocolRpcUrl`: your trusted Protocol RPC deployment service.
- `chainId`: expected chain ID, with matching Chain RPC and Protocol RPC deployment.
- `nativeCurrencySymbol` / `nativeCurrencyDecimals`: native gas-token display and amount precision.
- `suggestedGasBalance` / `helperGasBalance`: editable starting-balance suggestion and Charlie/Frank top-up target.
- `tokenAddress`: your funded standard ERC20 test token. The default iUSD is an existing testnet token; no token deployment is required.
- `bbBin`: path to Barretenberg 6.0.0 for real native proofs.

The checked setup uses a local tunnel at `http://127.0.0.1:18565` to a self-hosted full node. Replace it with your own full/archive RPC; the private infrastructure and Teleport access are not required. A node returning `missing trie node` for historical calls cannot support wallet history verification. Do not skip verification to work around it. Protocol deployment addresses are obtained and validated through Protocol RPC, rather than copied into each example.

Place the BB binary or a symlink at `examples/bin/bb`, or change `bbBin`. This directory is ignored by Git.

### Customize local accounts

Generate ten new local test accounts explicitly:

```sh
pnpm --filter @invisi-examples/scenarios accounts:init --execute
pnpm --filter @invisi-examples/scenarios accounts
```

Initialization writes `examples/accounts/accounts.json` with owner-only file permissions and refuses to overwrite an existing file. Accounts are ordered Alice, Bob, Charlie, Dave, Eve, Frank, Grace, Heidi, Ivan and Judy. Public addresses are printed; keys are not.

Alternatively, prepare your own local account file:

```sh
mkdir -p examples/accounts
cp -n examples/accounts.example.json examples/accounts/accounts.json
chmod 600 examples/accounts/accounts.json
```

Replace every placeholder with your own test account's EVM address and private key, then derive receiving addresses and viewing keys locally:

```sh
pnpm --filter @invisi-examples/scenarios accounts:receiving
```

The receiving-key script verifies existing derived fields before updating them; it never replaces EVM private keys. Keep account names and ordering. `getAccounts()` only reads this local file and creates public receiving wallets. A sender needs the recipient's public receiving address, not the recipient's private key.

Account files, encrypted SQLite inventory and sidecar files are ignored by Git. The repository contains no funded account keys or wallet databases. These plaintext local accounts and example storage-key derivation are for isolated testnet experiments; integrate your own key management in a real wallet.

### Fund the suite

Fund Alice and Bob with **the configured chain's native currency before running any on-chain examples**. ERC20 balances cannot pay gas. Charlie and Frank also submit transactions; the preparation script tops them up from Alice to `settings.helperGasBalance`.

| Account | Why it needs native currency | Preparation |
| --- | --- | --- |
| Alice (A) | Most transfers, aggregation, session transactions, and funding Charlie/Frank | Fund manually; see `settings.suggestedGasBalance` |
| Bob (B) | Registry registration/update and credit creation/top-up | Fund manually; see `settings.suggestedGasBalance` |
| Charlie (C) | Credit creation and cancellation | `prepare:suite` tops up to `settings.helperGasBalance` from Alice |
| Frank (F) | Delegated sweep submission | `prepare:suite` tops up to `settings.helperGasBalance` from Alice |
| Other recipients | Receive only in this suite | No native-token funding required |

The defaults use BSC Testnet 97 / tBNB, with a 0.1 starting suggestion and 0.01 helper target. Change all matching settings for another network, such as an ETH testnet. These are preparation amounts, not a gas-cost guarantee. The script prints all four gas balances and stops if Alice or Bob has no native currency. Gas prices and the selected transaction determine actual consumption. Also fund Alice with at least 100 units of the configured ERC20 and Bob with at least 100; adjust explicit example amounts for your token.
```sh
pnpm --filter @invisi-examples/scenarios prepare:suite --execute
```

This sends gas to Charlie and Frank if needed, and creates eight 1-token Alice notes plus four each for Bob and Charlie in two shield batches. Every explicit run creates new notes; run once before a fresh full-suite test. Existing account keys and token contracts are retained. Read the script before funding or executing it.

## Run examples

Read each file, then add `--execute` to opt into network access. Without it, on-chain examples stop before reading keys, opening a database or accessing the network. Each payment invocation is a new payment; do not rerun a payment to recover a pending transaction.

```sh
pnpm --filter @invisi-examples/scenarios example:transparent:1 --execute
```

| Category | Scripts | Coverage |
| --- | --- | --- |
| [00 Wallet](00-wallet/01-wallet.ts) | `example:wallet:1` | ethers mnemonic/private-key import, public wallet, viewer and detector capabilities |
| [01 Registry](01-address-registry/01-register-bob.ts) | `example:registry:1`, `:2` | Bob registration and update through external EIP-712 requests |
| [02 Transparent amounts](02-transparent-amount/01-alice-to-bob.ts) | `example:transparent:1`, `:1b`, `:1c`, `:2`, `:3`, `:4`, `:5` | Full receiving address, registered EVM address, explicit chain lookup, nine recipients, Bob funding authorization, raw memo payload, complete Shield broadcaster walkthrough |
| [03 Hidden amounts](03-hidden-amount/01-cash-to-bob-with-change.ts) | `example:hidden:1`, `:1b`, `:2`, `:3`, `:4`, `:4b`, `:5`, `:6` | Cash/notes, separate funding/spending signatures, change, withdrawal, delegated owner-only sweep, four-member aggregation |
| [04 Credit](04-credit/01-bob-and-charlie-create.ts) | `example:credit:1` through `:4` | Bob/Charlie create credit for Alice, multi-owner batch draw, top-up with notes/cash/change, cancellation |
| [05 WalletSession](05-wallet-session/01-restore-session.ts) | `example:session:1` through `:4` | Encrypted SQLite, incremental inventory, outgoing/incoming history, own cash/notes/gas, reopen and reconcile |
| [06 Disclosure](06-disclosure/01-note-opening.ts) | `example:disclosure:1` through `:3` | Historical funds opening, single-output payload key and memo, credit opening; independent canonical receipt verification |

Run in table order after suite preparation. Within categories, use the script order listed above. Wait for a successful receipt and for Protocol RPC's `indexedHead` to cover that block before the next dependent example. Registration 01 is a first registration; it reports an error if the same owner is already registered. Use update 02 for registered owners.

Discovery helpers return all authenticated candidates; amount selection remains visible in each example. Exact duplicate RPC records are ignored, while conflicting content or tree positions fail. Preparation rechecks current chain state. Do not automatically replace consumed inputs or blindly retry a transaction.

## Sessions and recovery

Category 05 shares `examples/accounts/alice-session.sqlite` and a namespace scoped to the protocol deployment. Example 02 intentionally stops after the actual chain receipt, leaving the persisted operation for example 04 to reopen and independently reconcile. It does not send the payment again. Wait for RPC indexing before reopening; a refresh cannot use an anchor older than the wallet's already observed state.

The sample HKDF storage key is separate from the spending key. A host wallet can supply its own `CryptoKey` to `EncryptedWalletCodec`, adapt a transactional Store, or use IndexedDB. Keep database and key management outside ordinary detached examples. Deleting the Store loses locally recorded outgoing private details; incoming notes can be rediscovered.

## Payloads and disclosure

Example 02-04 uses `fundsV1.encode()` / `decode()` explicitly. SDK envelopes use v1; `decryptNote()` returns raw application payload bytes. The comments show how an application can replace the codec with its own version and data format without injecting a codec into Invisi.

Category 06 discovers historical outputs, including spent ones, and verifies their canonical receipts. It does not print, write or send disclosure material. Full funds openings and single-output payload keys also permit consumption tracking and unsigned full sweep back to the original owner; they are not strictly read-only capabilities. Credit openings expose a shared-key hash, not the recovery key. Verification proves the selected output's content and inclusion, not payer identity, current unspent state or complete wallet history.

## Checks

```sh
pnpm --filter @invisi-examples/scenarios lint
pnpm examples wallet
pnpm lint
```

Keep SDK behavior tests in the owning packages. These examples use workspace packages and do not publish or install a released SDK version.

## Local deployment

Maintainers can use `pnpm deploy:local` with the sibling protocol repository and a fresh Anvil chain 31337. That tooling creates a separate deployment; changing example settings also requires a matching trusted Protocol RPC and funded accounts. The default walkthrough targets the deployed chain-97 protocol.

### Optional paid broadcasting

Start with [02-05 Shield via broadcaster](02-transparent-amount/05-shield-via-broadcaster.ts), the complete walkthrough. It shows business intent, `.withBroadcaster(client, { maxFeeAmount })`, final business/fee/gross amounts, ERC20 allowance, external funding signature, calldata export and submission. Shield needs neither a private-note authorization nor a ZK proof. Discover token-compatible clients with `protocol.getBroadcasters({ tokenAddress })`, choose a service, and set the final fee limit in `.withBroadcaster()`. A client can also be constructed directly from an RPC registration with `new BroadcasterClient(registration)`.


The same attachment method supports Transfer, Shield, Credit creation, top-up and cancellation. Credit draw and registration do not support broadcasting. Existing self-submission uses the original prepared handle and ethers. When private inputs already have sufficient change, that change pays the fee without increasing public funding. Otherwise an explicitly selected public funding source adds the fee to the original amount and requires an external funding signature; Shield uses that signature without a proof, while funded private operations prove before exporting funding authorization. Private inputs pay from notes/change without reducing business outputs or Credit balances. Cancellation deducts the fee from the refund. Preparation fails on insufficient funds, an excessive fee or an unstable estimate.

Approve the final gross funding amount separately, or supply `fundingPermit` to sign an exact final permit through your application once fee preparation stabilizes. An existing permit is rejected when its public funding amount would increase without that callback. Managed operations atomically replace reservations under one operation id; the former managed handle becomes stale. Detached originals remain usable for ordinary self-submission. Do not execute against a deployment until its fee-enabled ABI and authenticated circuits are installed.
