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
| `detectNotes(context, range)` | `{block, notes}`; requires `range.detectionKey` |
| `detectCreditStates(context, range)` | `{block, states: IndexedCreditState[]}`; requires detection key |
| `getNote(context, commitment, block)` | `{output, membership}` or `null`; ordinary Notes only |
| `getCreditState(context, commitment, block)` | `{state, membership}` or `null`; Credit authority only |
| `getTransactionNoteUpdates(context, hash, options?)` | Availability union with `notes` |
| `getTransactionCreditUpdates(context, hash, options?)` | Availability union with `states` and `transitions` |
| `isNoteSpent(context, nullifier, block, options?)` | Indexed ordinary Note consumption observation |
| `isCreditConsumed(context, nullifier, block, options?)` | Indexed Credit state consumption observation |
| `getCreditAllocation(context, owner, token, block, options?)` | `{block, shard: bigint, slot: number}` |
| `getCreditRevocationBitmap(context, owner, token, shard, word, block, options?)` | `{block, bitmap: bigint}` |
| `getMembership(context, input, block)` | Independently checked physical leaf proof |

Mixed `getUpdates`, `getEncryptedOutputs`, `getOutputs`, `getCreditOutputs`, `getTransactionUpdates` and ambiguous `isSpent` client aliases are removed. Matching old mixed server routes return `-32601`. `ProtocolDataProvider` now declares the four explicit range/detection methods, status and membership. Custom providers and refresh callers must migrate as a unit.

`ProtocolNoteOutput` has one optional encrypted envelope. `IndexedCreditState` represents one authority leaf and retains both owner/spender deliveries in on-chain order. No envelope-header heuristic classifies Credit as a Note. Creation registers authority without principal funding; an optional authorized fee is pulled from the owner wallet. Draw consumes N states and appends N successor states plus one ordinary receiver Note. Payer totals and usage are gross; the Note amount is gross minus the authorized fee accrued to the broadcaster ledger. Update preserves the original grant namespace and may charge an authorized owner fee. Revocation may charge an authorized owner fee and changes the grant bitmap without producing a state, Note or nullifier. Transitions accept only `CreditCreated`, `CreditDraw`, `CreditUpdated` and `CreditRevoked`; obsolete top-up/cancellation events are rejected.

Unfiltered methods reject `range.detectionKey`; invoke explicit detection methods instead. Detection requires an enabled service and validates the requested key before transmission. Pass only a detection key, never a viewing/spending key. For recovery, query unfiltered Credit transitions independently even when filtering encrypted candidates. Candidates and matching clues do not prove complete history. Clients must authenticate receipts, decrypt locally, recompute commitments and check canonical consumption before applying financial state. Indexed allocation/bitmap/consumption values remain observations: canonical block binding alone is not a storage proof of their values; compare them with independent contract reads when authorizing operations.

Ranges permit at most the exported `MAX_UPDATE_BLOCKS = 10000` inclusive blocks and must lie within deployment/indexed history. Clients validate anchors, duplicate/position conflicts, envelope bounds and per-item canonical block context, then recheck the end block. Range/status/transaction requests support `signal`; transport supports `timeoutMs` and optional bearer `token`. `ProtocolRpcError` exposes a safe `kind` and optional numeric code; credentials and upstream error text are redacted.

Transaction availability is independent of execution success. `not_found` means no mined receipt (possibly pending), with null block/status/collections. `pending_index` has an independently checked mined block and receipt status but null collections. `indexed` has typed arrays, empty for unrelated/reverted transactions. Indexed results require a canonical checkpoint; stale observed heads are retained only for unindexed availability. Every returned item must match the requested transaction. These methods do not poll or construct a range fallback.

Block numbers, tree IDs and timestamps normalize to bigint. ABI uint64/uint256 event fields retain decimal-string precision in public transition `data`; uint16 slots remain numbers. Credit allocation starts at shard `1n`, slot `0`; revocation bitmap word is 0–255. Revocation and consumption are separate: an unconsumed state may belong to a revoked grant.

`ProtocolDeployment`/`ContractDeployment` are defined in this package. Deployment records contain chain ID, Protocol and optional receiving/broadcaster registries with address, runtime hash and start block. `getReceivingAddress` and `getBroadcasters` preserve independent registry validation. SDK/Protocol consumers must not maintain a second deployment catalog.

The synchronized server uses index format 3 and snapshot format 2; existing operators must follow its explicit backup/fresh-reindex/rollback guide. This client does not migrate server databases or wallet stores.
