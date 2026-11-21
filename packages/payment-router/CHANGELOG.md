# @invisi-labs/payment-router

## Unreleased

- Add the shared `payment-router-gas-v1` local Router preview with `source: "model"`, conservative allowances on the existing Core baseline, safe-integer validation and cross-SDK vectors. Opaque 0x routes remain unavailable without a trusted independent gas budget; the service uses operator policy and live network gas pricing within configured caps.
- Add unsigned Core/Router/account draft preparation, `estimateRouterFee`, finalization helpers and formal quote-before-proof/signing flows for relayed token and sponsored native payments. Retain host-approved fees at or above the service floor within fee/input caps; rebuild the unsigned final fee/route before quoting.
- Use `payment-router-intent-v1` semantic quote identity: exclude proof and wallet signature limbs while binding all business fields and ordered delegation chain/address/nonce metadata. Preserve `hashRelayEnvelope` / `payment-router-envelope-v1` only for explicit legacy compatibility. Replayed accepted semantic intents retain their original outcome even when proof/signature bytes differ.
- Keep actual proof/Core/route hash and signature validation, plus full actual-call RPC estimation/simulation, at submission within signed gas/token fee caps. Preserve explicit host submission, distinct Router/account/EOA nonces, pinned delegation metadata and foreign-delegation refusal.
- Update workspace/package/RPC guides and typechecked token/native host examples for draft estimation, final quotes, proof/signing and saved-request recovery without automatic broadcast. Preserve provenance capability metadata without changing semantic Router hashing.
- Add the canonical PaymentRouter and delegated-account ABIs, four payment modes, EIP-712 intent/account signing, ERC20 allowance/permit helpers and full outer simulation.
- Quote native/ERC20 input with V3 and 0x; support same-token and native-to-WETH payments without a swap. Enforce canonical 0x calldata and current dependency bindings.
- Serialize EIP-7702 signature limbs as minimal geth JSON quantities, including leading-zero signatures; add wire, tampering and draft/final parity regressions. Keep native-only transaction methods explicitly documented as legacy. No package version change.

## 1.3.2

- Add the optional Payment Router client for atomic native-ETH payments through Uniswap V3 exact-output and compatible native 0x routes. Validate deployment bindings, exact funding calldata and full-call simulation; retain wallet signing and submission with the host. Align direct-adapter input validation and cross-SDK transaction vectors.
