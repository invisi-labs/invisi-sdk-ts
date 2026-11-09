# Native wallet transport

`@invisi-labs/native-wallet` adapts a host-owned native JSON bridge. It contains no private-key wallet implementation and never receives account keys.

```ts
import { createNativeWalletClient } from "@invisi-labs/native-wallet";

const nativeWallet = createNativeWalletClient(nativeModule);
const responses = await nativeWallet.execute([prepared.request]);
const result = await acceptWalletResponse(prepared, responses[0]!);
```

The host implements `executeWalletRequests(requests: string): Promise<string>`. Both strings encode JSON arrays. Requests use the core versioned wallet envelope. Each response repeats `version`, `id`, `ownerAddress`, and `method`, with exactly one of `result` or `error: { code: string }`. Native error codes contain no secret details. `WALLET_NOT_RECIPIENT` identifies a decryption nonmatch; other errors must remain failures.

Each batch accepts at most 1,024 requests with unique IDs and one owner, and each encoded request or response array is limited to 16 MiB. Empty batches return `[]` without contacting the host. The client validates every request before transport, rejects malformed response batches, and returns responses in request order even when the host changes their order. Per-item errors remain explicit responses; core acceptance throws `NativeWalletError` for them. Applications must accept successful responses through core's prepared-request validation before using their contents.

The host owns account selection, unlock and approval policy, native execution, and secret storage. Business code uses public `Wallet` objects from `@invisi-labs/core`.
