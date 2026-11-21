# @invisi-labs/payment-router

## Unreleased

- Add the canonical PaymentRouter and delegated-account ABIs, four payment modes, EIP-712 intent/account signing, exact ABI hashes, ERC20 allowance/permit helpers and full outer simulation.
- Quote native/ERC20 input with both V3 and 0x; support same-token and native-to-WETH payments without a swap. Enforce canonical 0x calldata and current dependency bindings.
- Add zero-value Broadcaster envelopes, geth authorization serialization and `payment-router-envelope-v1` hashes. Keep native-only transaction methods explicitly documented as legacy.
- Add shared four-mode/account vectors and authorization/envelope tampering regression coverage. No package version change.

## 1.3.2

- Add the optional Payment Router client for atomic native-ETH payments through Uniswap V3 exact-output and compatible native 0x routes. Validate deployment bindings, exact funding calldata and full-call simulation; retain wallet signing and submission with the host. Align direct-adapter input validation and cross-SDK transaction vectors.
