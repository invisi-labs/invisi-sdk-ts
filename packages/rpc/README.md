# @invisi-labs/rpc

Typed client for Invisi Protocol RPC.

```ts
const rpc = new ProtocolRpcClient("http://localhost:8080/v1");
```

`Invisi.connect()` supplies its Chain RPC reader automatically. Standalone data queries that verify blocks or roots require `rpc.withReader(reader)`. Deployment discovery does not require a reader. The options constructor remains available for authenticated gateways, custom fetch and timeouts.

 It retrieves indexed candidate transaction references and historical membership paths. It does not scan Chain RPC logs, build public trees, decrypt notes, store wallet state, sign transactions or generate proofs.

Apps discover supported chains before connecting a chain reader:

```ts
const chains = await ProtocolRpcClient.getChains("https://rpc.example/v1");
const selected = chains.find(chain => chain.chainId === chainId);
if (!selected) throw new Error("This service does not support the selected chain");
const rpc = new ProtocolRpcClient({ url: selected.rpcUrl, reader });
const protocol = await Protocol.fromRpc(rpc, provider);
```

`getChains(options, { signal })` uses `GET /v1`. It returns an immutable list of `{ chainId: bigint, protocolVersion: "1", rpcUrl: string }` and requires no Chain RPC, deployment or wallet. Supply `token`, `timeoutMs` or a custom `fetch` in options where needed. An empty list means the service has no active chains; transport, HTTP, timeout, cancellation and malformed-response failures throw `ProtocolRpcError`. The client validates chain IDs, versions, duplicate entries and advertised routes. Returned URLs preserve the selected service origin, deployment prefix and query parameters; reuse explicit authentication options when constructing the chain client.

Discovery describes the selected service's active chains, not all Invisi deployments or transaction availability. Protocol/circuit pauses and indexing progress require their own checks. Service discovery does not authenticate a deployment's publisher.

```ts
import { ProtocolRpcClient } from "@invisi-labs/rpc";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { Protocol } from "@invisi-labs/protocol";
import { JsonRpcProvider } from "ethers";

const provider = new JsonRpcProvider("http://localhost:8545");
const rpc = new ProtocolRpcClient({
    url: "http://localhost:8080/v1",
    reader: new EthersChainReader(provider),
});

const protocol = await Protocol.fromRpc(rpc, provider);
await protocol.validateDeployment(new EthersChainReader(provider));

const status = await rpc.getStatus(protocol.context);
if (status.indexedHead) {
    const page = await rpc.getUpdates(protocol.context, {
        fromBlock: status.indexedHead.number,
        toBlock: status.indexedHead.number,
    });
    console.log(page.transactionHashes);
}
```

`reader` implements the exported `ProtocolRpcReader` interface: only `getBlock` and `isKnownRoot` are required; the RPC package has no dependency on Protocol, wallet storage or adapters. The ethers adapter above supplies an implementation. Deployment pins and API/Protocol versions are checked before indexed data is used. Block anchors, historical roots and authentication paths are independently checked against Chain RPC. Candidate references do not prove complete wallet history.

- `getDeployment(chainId, { signal })`: load the selected chain endpoint's frozen Protocol and optional registry profile. It works before indexing has a checkpoint and binds this client to that deployment. A mismatched chain, version or later profile change is rejected.
- `getStatus(context, { signal })`: canonical indexed head and detection policy.
- `getUpdates(context, range)`: up to 100 anchored blocks, returning deduplicated candidate transaction hashes and all Credit transition references.
- `getTransactionUpdates(context, transactionHash, { signal })`: query RPC 1.1.4+ for one transaction, with canonical block validation and no range construction.
- `getMembership(context, input, block)`: a depth-16 path rooted in a canonical indexed root the contract still recognizes. Optional `input.root` pins a common root for multiple inputs from one tree.

Detection is explicit: pass a detection key as `range.detectionKey` and a bearer `token` in client options when required. Omitting the key requests unfiltered references. Viewing and spending private keys stay local. Requests support `timeoutMs`; range/status calls also accept an `AbortSignal`. Errors are represented by `ProtocolRpcError` with a `kind` and optional numeric `code`; upstream text and credentials are not included. A failed request does not fall back to scanning Chain RPC.

`Invisi({ provider, protocolRpc: rpc, store })` composes this client with wallet capabilities. `session.refresh({ fromBlock })` handles bounded pages, independent receipt lookup, local authenticated decryption and wallet-state updates.

`ProtocolDeployment` and `ContractDeployment` are defined only in this package. A deployment contains `chainId`, `protocol` and optional `registry`; both contract entries use `address`, `runtimeCodeHash`, `fromBlock`. SDK and Protocol consume these types without maintaining another profile or catalog.

A versioned service URL (`/v1`) is routed to `/v1/chains/<chainId>` by `getDeployment(chainId)` or `Protocol.fromRpc(rpc, provider)`. An explicitly discovered chain URL is also supported. Once deployment pins exist, all indexed queries keep using that chain; the configured service URL is unchanged. Deployment discovery uses `invisi_getDeployment` with no parameters. An application trusts the selected service to identify its pool; returned address/hash pairs alone cannot establish official provenance. `Protocol.validateDeployment()` checks chain ID, deployed runtime and (with the ethers reader) onchain VERSION. Registry use independently validates its runtime. Optional constructor `deployment` pins an independently trusted profile and allows indexed queries without discovery.

`await Protocol.fromRpc(rpc, provider, { signal })` loads the deployment and validates its chain ID, runtime bytecode and available onchain version before returning. `Invisi.connect()` also validates the deployment when opening a session. Failed lookup rejects without another service or local fallback.

## Single-transaction updates

```ts
const updates = await rpc.getTransactionUpdates(protocol.context, transactionHash);
if (updates.status === "indexed") {
    console.log(updates.block.number, updates.receiptStatus);
    console.log(updates.outputs, updates.creditTransitions);
} else {
    console.log(updates.status);
}
```

`ProtocolTransactionUpdates` is a discriminated union. `not_found` means Chain RPC has no mined receipt (unknown or still pending); its block and receipt status are null. `pending_index` includes a canonical mined block and receipt status but no indexed updates yet. Both states retain null output/transition collections. Only `indexed` has arrays; empty arrays mean no matching protocol updates. `receiptStatus` is 0 for EVM reversion or 1 for success, independently of availability.

Block references and tree IDs normalize to bigint. For `not_found` and `pending_index`, `indexedHead` is an observed checkpoint and may remain on a stale fork; it is not a canonical-history claim. The mined transaction block is independently checked, and indexed results additionally require a canonical checkpoint. Outputs reuse the existing opaque output parser, including delivery/position validation and duplicate handling; both Credit role envelopes are retained. Credit transitions retain their named event, canonical block, transaction hash, log index and unparsed public `data`. Every returned item must match the requested transaction and block. Null indexed arrays, malformed metadata, conflicting duplicates and observed reorganizations fail with `ProtocolRpcError`.

This method requires the same pinned deployment and independent Chain RPC reader as range queries. It does not poll, fall back to ranges, decrypt payloads, update a wallet Store or establish event completeness. Authenticate receipts and membership before applying candidates to financial state. Existing `ProtocolDataProvider` implementations used for range synchronization do not need to implement this additional client method.
