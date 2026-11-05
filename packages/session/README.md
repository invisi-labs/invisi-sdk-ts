# @invisi-labs/session

Managed wallet state for browsers, merchants and services. The package depends on the stateless `@invisi-labs/sdk` and adds inventory, selection, reservations, history, canonical updates and recoverable operations.

```ts
import { Invisi, Wallet } from "@invisi-labs/sdk";
import { WalletSession } from "@invisi-labs/session";
import { MemoryWalletStore } from "@invisi-labs/session/memory";

const invisi = new Invisi({ provider, protocolRpc, prover });
const wallet = await Wallet.fromPrivateKey(privateKey);
const session = await WalletSession.connect({
    invisi,
    wallet,
    protocol,
    store: new MemoryWalletStore(),
});
await session.refresh({ fromBlock: protocol.deployment.protocol.fromBlock });
const balance = await session.balance(tokenAddress);
```

Memory storage is explicitly ephemeral. Persistent hosts import `@invisi-labs/session/indexeddb` or `@invisi-labs/session/sqlite` and supply an `EncryptedWalletCodec` with their own encryption key and database connection. Adapters do not choose keys or open an application database implicitly.

`new WalletSession(...)` constructs a lazy handle. Its asynchronous methods validate the configured chain and pinned deployment before reading or modifying wallet state. `WalletSession.connect(...)` validates immediately. Both accept shared infrastructure through `invisi`; the session alone receives store, namespace, signer, viewing, authorization, fundingSigner and coinSelector capabilities.

`Operation` owns persisted lifecycle and recovery. `PreparedTransaction` remains in `@invisi-labs/sdk` for callers that supply notes explicitly and own their state. Either can export calldata for an external ethers signer. Session sending is a thin delegation to its optional ethers signer.
