# TypeScript examples

Each named scenario is a flat, independent script. Account keys, viewing keys, detection keys, EVM signing, and transaction submission belong to the host. These examples contain no local account executor. Only the offline Note output example runs without `--execute`.

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

Without `--execute`, live scripts exit before reading account configuration, environment inputs, opening databases, or connecting to RPC. Running with it can read sensitive note openings and persist encrypted wallet state, but never submits a transaction.

## Public Wallet initialization

When the host already supplies a complete receiving address, initialize with `Wallet.fromAddress(receivingAddress)`. If only the EVM owner is available, request its public profile first. `nativeWallet` is the host bridge; it keeps account selection and keys outside the SDK.

```ts
import { Wallet, ReceivingAddress, prepareWalletRequest, acceptWalletResponse } from "@invisi-labs/core";
import { getBytes } from "ethers";

const owner = Wallet.fromAddress(ownerAddress);
const request = prepareWalletRequest(owner, "public-profile", "wallet.public", {});
const responses = await nativeWallet.execute([request]);
const response = responses.find((item) => item.id === request.id);
if (!response) throw new Error("Missing public-profile response");

// Validate the response against the retained owner and request before using the keys.
const profile = await acceptWalletResponse(request, response);
const wallet = Wallet.fromAddress(ReceivingAddress.from({
    ownerAddress: owner.ownerAddress,
    viewingPublicKey: getBytes(profile.viewingPublicKey),
    clueKey: getBytes(profile.clueKey),
}));
console.log(wallet.getAddress());
```

## Host request and response boundaries

Private authorization and decryption use the five-method core wallet protocol. A scenario exports its retained request, calls `nativeWallet.execute([request])`, selects the response by ID, and attaches it with `withWalletResponse` or core `acceptWalletResponse`. The shared `host-transport.ts` contains only JSON/terminal framing: it prints the entire request array and reads one response-array line. Implement this boundary with your own native bridge in an application.

Each wallet response repeats `version`, `id`, `ownerAddress`, and `method` and contains exactly one of `result` or `error: { code }`. Errors remain explicit; only `WALLET_NOT_RECIPIENT` is a decryption nonmatch. The SDK validates complete batch envelopes before accepting cryptographic results. Never substitute `null` for failed requests.

Funding and address registration use separate EVM typed-data requests. Their printed arrays contain an application `id`, `kind`, and the SDK's EIP-712 request. Have the host review and sign that request, then paste `[{"id":"the-printed-id","signature":"0x..."}]`. These application envelopes are not additional native-wallet protocol methods. The SDK checks returned signatures against the retained intent. Caller-funded transactions instead require submission by their specified payer. Token balances, ERC20 allowance, gas, and submission remain host responsibilities; no script approves or broadcasts automatically.

The final output is an unsigned transaction. Review its chain, target, value, calldata, and required caller before host submission. The broadcaster example obtains a verified fee quote and exports the resulting calldata; it does not call the broadcaster's submit endpoint.

## Scenarios

- `01-address-registry`: initial registration and update, with external EVM authorization.
- `02-transparent-amount`: offline Note output construction, shield one or nine outputs, registered-address lookup, explicit chain lookup, external funding signature, memo, and verified broadcaster quote.
- `03-hidden-amount`: cash plus change, notes plus cash, three recipients, full owner withdrawal, partial public withdrawal plus private output/change, third-party owner sweep, and four-member two-party aggregation. Full owner sweeps require proof but no private spending authorization. Other transfers request authorization when their prepared preview requires it.
- `04-credit`: independent owner grants, batch draws, current-state policy/balance update, and public owner revocation. Principal remains with the owner until draw.
- `05-wallet-session`: encrypted SQLite restoration, explicit refresh batches, persisted shield/transfer preparation, and operation reconciliation. There is no injected private executor or automatic signer.
- `06-disclosure`: independently read canonical receipt evidence, request native decryption, validate the returned opening, and verify a transferable disclosure. The memo example decodes the native-authenticated application payload without claiming its financial opening proves the memo.

## Automatic discovery and recovery

Note and Credit examples discover outputs automatically through the configured Protocol RPC. You do not supply plaintext note input JSON. `discover-candidates.ts` and `discover-credits.ts` paginate indexed history, export native decryption batches, accept successful plaintext through core validation, and check the independent canonical receipt. They reject conflicting indexed rows and propagate every error except an explicit `WALLET_NOT_RECIPIENT` nonmatch. Indexed nullifiers and Credit revocation bitmaps filter current inventory; preparation independently checks current on-chain membership and eligibility again.

Selection and amount calculations remain visible in each scenario. The cash-only examples create their own outputs; later note scenarios discover those receipts after host submission and indexing. Aggregation discovers each participant's notes separately, requests their authorization separately, and combines only their public proved aggregate members. Credit revocation discovers a current owner grant and uses its public revocation location.

Disclosure examples discover historical outputs, including spent notes or consumed grants, and use canonical receipt evidence before exporting financial openings. The memo example decodes the host-authenticated application payload and explicitly states that a financial opening does not prove memo bytes to a third party. The current five-method native protocol exports plaintext, not a payload decryption key; these examples never introduce an unsupported native method or reconstruct a viewing key. Openings do not establish payer identity or current unspent status.

Session examples require Node.js 22.13+ and `STORE_ENCRYPTION_KEY_HEX`, a dedicated external 32-byte storage encryption key, plus optional `WALLET_DB` (default `examples/accounts/alice-session.sqlite`, resolved independently of the working directory). This key is solely for the encrypted store and must be supplied by host key management independently of account material. Use the same key, path, and namespace when restoring. Refresh remains visibly two steps: `nativeWallet.execute(pending.walletRequests)` and `pending.applyWalletResponses(responses)`. Keep exported operation IDs so a host can reconcile an existing submission rather than create a second payment.

After external submission, recovery optionally reads `HOST_TRANSACTIONS_JSON`, an object mapping persisted operation IDs to host transaction hashes. It attaches these hashes with `trackTransaction` and reconciles canonical receipts without resending or signing again.
