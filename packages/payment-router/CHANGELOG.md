# @invisi-labs/payment-router

## 1.3.6

- Align exact SDK, protocol and primitives dependencies with the 1.3.6 release group. Canonical Router, EIP-7702 and swap host interfaces are unchanged; unsigned host integrations retain responsibility for durable submission recovery.

## 1.3.5

- Release with exact 1.3.5 dependencies for new v1 receiving material and the streamlined proving lifecycle. Router intent identity and deployed ABI remain unchanged.

## 1.3.4

- Release with exact SDK 1.3.4 dependencies, inheriting Note/Credit address normalization and fee-free Credit pre-revocation from the SDK. Payment Router implementation, intent identity and deployed ABI bindings remain unchanged from 1.3.3.

## 1.3.3

- Add canonical PaymentRouter and delegated-account ABI snapshots, four payment modes, EIP-712 Router/account intent signing, allowance/permit helpers and full outer-call simulation. Support native/ERC20 inputs, same-token payments and native-to-WETH routes with Uniswap V3 or canonical 0x calldata.
- Add unsigned Core/Router/account draft preparation, `estimateRouterFee` and finalization helpers so hosts obtain semantic quotes before proving or signing. Preserve host-approved fees at or above the service floor within signed fee/input caps, then rebuild the final unsigned fee and route before quoting.
- Use `payment-router-intent-v1` identity to bind all business fields and ordered delegation chain/address/nonce metadata while excluding proof and wallet signature limbs. Replayed accepted intents retain their original outcome when proof/signature bytes differ. Keep `hashRelayEnvelope` / `payment-router-envelope-v1` for explicit legacy compatibility.
- Verify accepted relay quotes and submit the bound envelope explicitly. Validate actual proof/Core/route hashes and signatures at submission, estimate/simulate the actual call within signed gas/token-fee caps, distinguish Router/account/EOA nonces and reject foreign delegation.
- Add the shared `payment-router-gas-v1` local preview with conservative allowances over the Core baseline and safe-integer validation. Opaque 0x routes require a trusted independent gas budget; service operators still apply live gas pricing and policy caps.
- Serialize EIP-7702 signature limbs as minimal geth JSON quantities, including leading-zero signatures. Expand host guides and typechecked token/native/7702 examples for quote-before-proof/signing, accepted route expiry and saved-request recovery; retain Provenance capability metadata without changing semantic Router identity.
- Migration: use current Router/account contracts and semantic intent quotes for canonical APIs; native-only transaction methods and envelope identity remain explicit legacy paths. Hosts retain control of signing and transaction submission.

## 1.3.2

- Add the optional Payment Router client for atomic native-ETH payments through Uniswap V3 exact-output and compatible native 0x routes. Validate deployment bindings, exact funding calldata and full-call simulation; retain wallet signing and submission with the host. Align direct-adapter input validation and cross-SDK transaction vectors.
