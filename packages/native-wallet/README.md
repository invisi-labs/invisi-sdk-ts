# Native wallet transport

`@invisi-labs/native-wallet` connects a host-provided native module to the SDK's portable wallet request protocol. It contains no private keys, native cryptography implementation, React Native registration, or platform-specific binary.

```ts
import { createNativeWalletProvider } from "@invisi-labs/native-wallet";

const walletProvider = createNativeWalletProvider({
    executeWalletRequest: (requestJson) => nativeModule.executeWalletRequest(requestJson),
});
```

The host must supply `nativeModule` using its own React Native module, mobile FFI binding, or Node integration. It keeps keys inside that implementation and executes the JSON request. Business code uses `Wallet` from `@invisi-labs/core`; local Node tooling may explicitly import `LocalWallet` from `@invisi-labs/core/local`.

Requests and responses carry `version`, `id`, `ownerAddress`, and `method`. The SDK retains the prepared request and validates the returned envelope, authorization signature and digest, and decrypted financial commitments before accepting results. Integers are canonical decimal strings; byte arrays are lowercase `0x` hex. The transport does not authorize or validate financial results itself.

Methods: `wallet.public`, `wallet.detect`, `wallet.decryptNote`, `wallet.decryptCredit`, and `wallet.authorize`. No method returns private viewing, detection, or spending keys. Public interoperability fixtures live in `packages/core/src/wallet/testdata/wallet-wire-vectors.json`.

The provider is owned by the App, never passed to `WalletSession.connect`. Execute each
request outside the Session and pass the response to its prepared handle. Native errors
are surfaced as `NativeWalletError` with a machine-readable `code`; native diagnostic
messages are not forwarded. Failed unlocks and rejected approvals leave the staged work
pending. Only the host can explicitly classify a delivery as a nonrecipient (`null`).
