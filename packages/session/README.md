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
await pending.decrypt(decryptor); // App-supplied DeliveryDecryptor
const balance = await session.balance(tokenAddress);
```

Memory storage is explicitly ephemeral. Persistent hosts import `@invisi-labs/session/indexeddb` or `@invisi-labs/session/sqlite` and supply an `EncryptedWalletCodec` with their own encryption key and database connection. Adapters do not choose keys or open an application database implicitly.

`new WalletSession(...)` constructs a lazy handle. Its asynchronous methods validate the configured chain and pinned deployment before reading or modifying wallet state. `WalletSession.connect(...)` validates immediately. Both accept shared infrastructure through `invisi`; the session alone receives store, namespace, signer, fundingSigner and coinSelector capabilities.

`Operation` owns persisted lifecycle and recovery. `PreparedTransaction` remains in `@invisi-labs/sdk` for callers that supply notes explicitly and own their state. Either can export calldata for an external ethers signer. Session sending is a thin delegation to its optional ethers signer.

The SDK keeps ordinary Note inventory and deferred Credit states separate. Credit creation/update charge only an optional owner-wallet fee; draw receipts and usage are gross, while the ordinary recipient Note receives gross minus fee. Public revocation uses its grant reference and owner EIP712/ERC1271 authorization without a prover.


Private Noir wallet authorization signatures and witnesses are not persisted. Public funding/revocation signatures embedded in final calldata may remain in the encrypted operation journal so recovery can reconcile the exact request; this public authorization material is a separate persistence boundary.

Session owns no wallet transport. Refresh stages canonical pages, then `pending.decrypt(decryptor)` invokes the App-supplied `DeliveryDecryptor`. Callbacks return plaintext bytes or `null` for nonrecipients; all other failures reject. SDK validation binds plaintext to owner, token, deployment, commitment and Credit receiving keys. No key storage, unlocking or App bridge is implemented here.

Decrypt/apply rechecks canonical receipts and commits atomically with the original store revision. A failed callback, invalid plaintext, concurrent state change or reorg leaves the refresh uncommitted. Concurrent apply attempts and reuse after success reject. Even an empty page requires `pending.decrypt(decryptor)` to finalize.

Authorization uses `operation.exportWalletAuthorization()`, ethers `signTypedData()` and `operation.withWalletSignature(signature)`. Native request/response envelopes are unnecessary.

The App decryptor must authenticate the ciphertext (including the AEAD tag) before returning plaintext. Commitment checks validate financial contents; they do not independently authenticate opaque memo bytes.

### Managed Credit examples

See [the Credit walkthrough](../../examples/README.md#managed-credit-walkthrough) for four flat SQLite-backed Session mains: create, batch draw across different payers, update remaining quota, and proofless owner revocation. All use the same public Wallet and explicitly injected App decryptor as Note payments. Example 4 recovers both Note and Credit operations with the original account and encrypted store. Credit authority and reservations stay separate from ordinary Note balances; successful draws issue ordinary recipient Notes.
