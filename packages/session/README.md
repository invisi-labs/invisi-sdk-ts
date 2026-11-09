# @invisi-labs/session

Managed wallet state for browsers, merchants and services. The package depends on the stateless `@invisi-labs/sdk` and adds inventory, selection, reservations, history, canonical updates and recoverable operations.

```ts
import { Invisi, Wallet } from "@invisi-labs/sdk";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";

const invisi = new Invisi({ provider, protocolRpc, prover });
const wallet = Wallet.fromAddress(receivingAddress);
const session = await WalletSession.connect({
    invisi,
    wallet,
    protocol,
    store: new MemoryWalletStore(),
});
const pending = await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });
const responses = await Promise.all(pending.walletRequests.map(async (request) => ({
    requestId: request.id, response: await nativeWallet.execute(request),
})));
await pending.applyWalletResponses(responses);
const balance = await session.balance(tokenAddress);
```

Memory storage is explicitly ephemeral. Persistent hosts import `@invisi-labs/session/indexeddb` or `@invisi-labs/session/sqlite` and supply an `EncryptedWalletCodec` with their own encryption key and database connection. Adapters do not choose keys or open an application database implicitly.

`new WalletSession(...)` constructs a lazy handle. Its asynchronous methods validate the configured chain and pinned deployment before reading or modifying wallet state. `WalletSession.connect(...)` validates immediately. Both accept shared infrastructure through `invisi`; the session alone receives store, namespace, signer, fundingSigner and coinSelector capabilities.

`Operation` owns persisted lifecycle and recovery. `PreparedTransaction` remains in `@invisi-labs/sdk` for callers that supply notes explicitly and own their state. Either can export calldata for an external ethers signer. Session sending is a thin delegation to its optional ethers signer.

The SDK keeps ordinary Note inventory and deferred Credit states separate. Credit creation/update charge only an optional owner-wallet fee; draw receipts and usage are gross, while the ordinary recipient Note receives gross minus fee. Public revocation uses its grant reference and owner EIP712/ERC1271 authorization without a prover.


Private Noir wallet authorization signatures and witnesses are not persisted. Public funding/revocation signatures embedded in final calldata may remain in the encrypted operation journal so recovery can reconcile the exact request; this public authorization material is a separate persistence boundary.

Session owns no native executor. Each refresh returns a staged handle containing serializable
`walletRequests`. The host supplies one `{requestId, response}` per request; explicit
`response: null` means the host determined a ciphertext is not for this account. Transport
or unlock failures should be retried rather than converted to nonrecipient outcomes.
No inventory or checkpoint changes before apply. Apply validates all results, rechecks
canonical chain data and commits atomically if the original store revision is unchanged.
An empty request list still requires `applyWalletResponses([])` to finalize.

Private authorization uses `operation.exportWalletRequest(id)` followed by host execution
and `operation.withWalletResponse(response)`, identical to detached SDK preparation.
