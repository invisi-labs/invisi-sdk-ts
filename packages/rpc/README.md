# @invisi-labs/rpc

Typed, deployment-pinned client for public Invisi Protocol history. Note and Credit have independent business methods and types; only physical tree membership and low-level canonical events share infrastructure.

```ts
const rpc = new ProtocolRpcClient({
    url: "https://rpc.example/v1",
    reader: new EthersChainReader(provider),
});
const protocol = await Protocol.fromRpc(rpc, provider);
const status = await rpc.getStatus(protocol.context);
if (status.indexedHead) {
    const range = {
        fromBlock: status.indexedHead.number,
        toBlock: status.indexedHead.number,
    };
    const notes = await rpc.getNoteUpdates(protocol.context, range);
    const credits = await rpc.getCreditTransitions(protocol.context, range);
    console.log(notes.notes, credits.transitions);
}
```

A string URL is accepted synchronously. `getDeployment(chainId, {signal})` or `Protocol.fromRpc` selects `/v1/chains/<chainId>` and freezes its deployment pins. An explicitly discovered chain URL is also supported. `ProtocolRpcClient.getChains()` discovers active routes without a chain reader. Optional constructor `deployment` independently pins an expected deployment. Returned metadata does not establish that a deployment is official; select a trusted service. Discovery preserves API version `v1` and on-chain Protocol version `1`.

The exported `ProtocolRpcReader` requires only `getBlock` and `isKnownRoot`. Canonical block hashes/timestamps, physical roots and depth-16 membership paths are checked against this independent reader. The RPC package depends on neither Protocol builders nor wallet storage. No request falls back to scanning Chain RPC when the service fails.

| Client method | Result |
| --- | --- |
| `getNoteUpdates(context, range)` | `{block, notes: ProtocolNoteOutput[]}` |
| `getCreditTransitions(context, range)` | `{block, transitions: ProtocolCreditTransition[]}` |
| `getNote(context, commitment, block)` | `{output, membership}` or `null`; ordinary Notes only |
| `getCreditState(context, commitment, block)` | `{state, membership}` or `null`; Credit authority only |
| `getTransactionNoteUpdates(context, hash, options?)` | Availability union with `notes` |
| `getTransactionCreditUpdates(context, hash, options?)` | Availability union with `states` and `transitions` |
| `isNoteSpent(context, nullifier, block, options?)` | Indexed ordinary Note consumption observation |
| `isCreditConsumed(context, nullifier, block, options?)` | Indexed Credit state consumption observation |
| `getCreditStatus(context, owner, token, grantId, block, options?)` | `{block, status: 0\|1\|2}`; positive uint128 grant ID |
| `getMembership(context, input, block)` | Independently checked physical leaf proof |

Mixed `getUpdates`, `getEncryptedOutputs`, `getOutputs`, `getCreditOutputs`, `getTransactionUpdates` and ambiguous `isSpent` client aliases are removed. Matching old mixed server routes return `-32601`. `ProtocolDataProvider` now declares the four explicit range/detection methods, status and membership. Custom providers and refresh callers must migrate as a unit.

`ProtocolNoteOutput` has one optional encrypted envelope. `IndexedCreditState` represents one authority leaf and retains both owner/spender deliveries in on-chain order. No envelope-header heuristic classifies Credit as a Note. Creation registers authority without principal funding; an optional authorized fee is pulled from the owner wallet. Draw consumes N states and appends N successor states plus one ordinary receiver Note. Payer totals and usage are gross; the Note amount is gross minus the authorized fee accrued to the broadcaster ledger. Update preserves the original grant namespace and may charge an authorized owner fee. Revocation may charge an authorized owner fee and permanently disables the scoped grant ID without producing a state, Note or nullifier. Transitions accept only `CreditCreated`, `CreditDraw`, `CreditStateTransition`, `CreditUpdated` and `CreditRevoked`; obsolete top-up/cancellation events are rejected.

The client fetches public Note updates and Credit transitions without sending account detection keys. Detection and authenticated decryption run locally through wallet adapters. Clients must authenticate receipts, decrypt locally, recompute commitments and check canonical consumption before applying financial state. Indexed grant-status/consumption values remain observations: canonical block binding alone is not a storage proof of their values; compare them with independent contract reads when authorizing operations.

Ranges permit at most the exported `MAX_UPDATE_BLOCKS = 10000` inclusive blocks and must lie within deployment/indexed history. Clients validate anchors, duplicate/position conflicts, envelope bounds and per-item canonical block context, then recheck the end block. Range/status/transaction requests support `signal`; transport supports `timeoutMs` and optional bearer `token`. `ProtocolRpcError` exposes a safe `kind` and optional numeric code; credentials and upstream error text are redacted.

Transaction availability is independent of execution success. `not_found` means no mined receipt (possibly pending), with null block/status/collections. `pending_index` has an independently checked mined block and receipt status but null collections. `indexed` has typed arrays, empty for unrelated/reverted transactions. Indexed results require a canonical checkpoint; stale observed heads are retained only for unindexed availability. Every returned item must match the requested transaction. These methods do not poll or construct a range fallback.

Block numbers, tree IDs and timestamps normalize to bigint. ABI uint64/uint256 event fields retain decimal-string precision in public transition `data`; Grant IDs are positive uint128 values and use canonical decimal strings on the RPC wire. Status is 0 unknown, 1 active, or 2 permanently disabled; revoke accepts 0 or 1 and 2 can never be reused. Revocation and consumption are separate: an unconsumed state may belong to a revoked grant.

`ProtocolDeployment`/`ContractDeployment` are defined in this package. Deployment records contain chain ID, Protocol and optional receiving/broadcaster registries with address, runtime hash and start block. `getReceivingAddress` and `getBroadcasters` preserve independent registry validation. SDK/Protocol consumers must not maintain a second deployment catalog.

The synchronized server uses index format 3 and snapshot format 2; existing operators must follow its explicit backup/fresh-reindex/rollback guide. This client does not migrate server databases or wallet stores.

### Trusted Protocol RPC chain reader

The opt-in `@invisi-labs/rpc/trusted-provider` entry exports `TrustedProvider`, which implements `ChainReader` using only `invisi_readChainState`. It trusts the selected publisher for chain facts and does not independently authenticate Ethereum. Construct the client with explicit deployment pins (discovered pins alone are insufficient):

```ts
import { ProtocolRpcClient } from "@invisi-labs/rpc";
import { TrustedProvider } from "@invisi-labs/rpc/trusted-provider";
const client = new ProtocolRpcClient({ url: "https://rpc.example/v1", deployment });
const chainReader = new TrustedProvider(client, {
    chainId: deployment.chainId,
    protocolAddress: deployment.protocol.address,
});
const rpc = client.withReader(chainReader);
// Supply { chainReader, protocolRpc: rpc } to Invisi; no ethers provider is needed.
```

Each response must match the complete deployment and `v1`/`1` version pins. Headers are bound to their encoded hash and requested number; receipts to their transaction and canonical header; signed transactions to their computed hash. The reader supports latest/safe/finalized blocks, code, restricted contract calls, funding nonces, roots, nullifier state and token balance/allowance reads. It exposes no chain transaction submission or generic Ethereum RPC transport. The service allowlist determines which contract calls are available.

## Contributing

See the [contribution guidelines](../../README.md#contributing) for issues, pull requests, validation, and handling sensitive material.

After broadcasting an address registration, persist
`ready.trackTransaction(hash).confirmationSnapshot()` as JSON. On restart,
pass the same wallet and registry deployment to
`RegistrationOperation.restoreConfirmation(registry, { wallet, reader }, snapshot)`.
It checks the original transaction and receipt. If the result is uncertain,
call `reconcile()` again. Restored operations cannot export a transaction.

## PaymentRouter Broadcaster requests

Router relay uses `PaymentRouterRelayClient` from `@invisi-labs/payment-router`. It sends the standard `broadcaster_estimateQuote`, `broadcaster_getQuote` and `broadcaster_submitTransaction` methods with `{data, router:{to,data,value:"0",authorizationList?}}`; submit adds the signed `quote` and `signature`. Embedded Core data must equal the Core call inside its own outer transaction at both draft and final stages. New quotes use `requestHashFormat: "payment-router-intent-v1"` and `execution: "direct"`. The ordinary Core `BroadcasterClient` verifies a different hash. Router scheduling, aggregation and private-input funding are rejected.

Prepare an unsigned Router draft, preview local gas, call `estimateRouterFee` (alias `estimateQuote`), then rebuild the unsigned Core fee and exact-output route as needed. The final host-approved Core fee must cover the service floor and stay within the user's fee/input caps; an approved fee above the floor can be retained. Obtain the formal quote on that final draft **before proving or signing**. The service checks draft business fields, deployment and live nonce/delegation metadata without requiring player or EIP-7702 signatures or full-call simulation. After the quote, prove, rebuild the actual proof-dependent Router/account signing hashes, and sign the final calls and any required delegation authorization.

Router local previews use the shared `payment-router-gas-v1` profile with `source: "model"`: conservative engineering allowances added to the existing Core baseline, not measured swap benchmarks. Opaque 0x previews are unavailable without an independently trusted route gas budget; the Broadcaster uses its own configured operator budget and ignores client gas hints. Service fee pricing uses live network gas fees within operator caps and settles in the Core output token through its fee ledger. Full actual-call RPC estimation/simulation and proof/hash/signature validation occur at submission, within the signed gas/token fee caps. Sponsored native outer value is zero; the payer account funds principal.

Semantic identity excludes proof bytes and Router/account/permit/EIP-7702 signature limbs, while binding every business field and ordered delegation chain/address/nonce metadata. The same quote therefore verifies before and after proving/signing. `hashRelayEnvelope` and `payment-router-envelope-v1` remain explicit legacy compatibility utilities. Save the final input and signed quote before explicit submission; replay of an accepted semantic intent returns its existing outcome, including when proof/signature bytes differ. Recover uncertain submissions from the saved request without automatic rebroadcast. See the [PaymentRouter guide](../payment-router/README.md) for deployment trust, nonce/delegation handling, recovery limits and `broadcaster_getTransactionStatus({id})`. The dedicated Router client currently exposes no status convenience method or expired-quote recovery bypass; use a host JSON-RPC transport for those operations.
