# @invisi-labs/payment-router

Atomic native/ERC20 payments for the canonical `invisi-periphery` PaymentRouter at `ffd81f4`. Supports direct native, direct ERC20, signed relayed ERC20 and delegated-account sponsored native payments. Core proofs and settlement remain unchanged. Wallet keys and transaction submission remain host-provided.

## Canonical PaymentRouter

Use `paymentRouterAbi` and `paymentRouterAccountAbi` for the unified deployment. `preparePayment` binds the Core funding payer to the Router; prove the returned prepared transaction before quoting. The Core funding amount includes note outputs **and** the Core token fee. Use `tokenIn: ZeroAddress` for native input; ERC20 addresses select token input. Both `UniswapV3Adapter` and `ZeroExAdapter` accept `tokenIn`; V3 paths run from the effective input (WETH for native) to the Core token. ERC20 0x quotes must use the configured AllowanceHolder and current registry Settler. Structural checks do not certify opaque liquidity actions; simulate the complete call.

```ts
const quote = await client.quote(adapter, {
  tokenIn, tokenOut, amountOut: fundingAmount, maxInput, deadline,
});
const payment = await client.prepareRouterPayment({
  payment: ready, payer, tokenIn, mode: PaymentMode.RelayedToken,
  refundRecipient: payer, relayer, deadline, amountInMaximum: quote.maxInput, quote,
});
payment.signature = await signPaymentIntent(signer, deployment.chainId, deployment.routerAddress, payment.intent);
const outer = client.buildRouterTransaction(payment);
await client.simulateRouterPayment(outer, { from: relayer });
const rpcFields = relayEnvelope((await ready.exportTransaction()).data, outer);
const quoteHash = hashRelayEnvelope(deployment.chainId, deployment.coreAddress, outer);
// Pass rpcFields beside normal fee fields to Broadcaster estimate/quote/submit.
// Compare its hash under PAYMENT_ROUTER_ENVELOPE_HASH_FORMAT before submission.
```

For direct submission, select `PaymentMode.DirectNative` or `PaymentMode.DirectToken`, omit `relayer` and signature, simulate from `payer`, and send the returned call from that wallet. Native `value` is the maximum input; token calls have zero value. Omit `quote` for same-token input or native-to-WETH wrapping; `noSwapRoute` is selected automatically. Low-level `buildPaymentIntent`, `hashCoreRequest`, `hashRoute`, `intentTypedData`, `hashPaymentIntent` and `buildRouterPayment` support detached integrations. The typed intent binds the exact proof, Core request, route, payer, Router nonce, budget, deadline and fixed relayer.

ERC20 withdrawal additionally requires `inputApproval`/`inputAllowance`, or an ERC-2612 permit constructed with `inputPermitTypedData` and `signedInputPermit`. Set `payment.permit` before encoding; no permit is assumed for WETH. Token-domain metadata and token permit nonce come from the host. An allowance or permit does not replace the relayed intent signature.

For sponsored native input, select `PaymentMode.SponsoredNative`, build the inner Router call, then use `prepareNativeAccountPayment(provider, {chainId, implementation, payer, routerCall, deadline, relayer}, {implementationCodeHash?, undelegatedNonce?})`. It checks the implementation's pinned Router/code hash and refuses another installed implementation. When no delegation is installed, explicitly supply the known action nonce (`0n` only for a fresh account); revoking delegation preserves old action storage. Sign `result.authorizationRequest` with a compatible wallet's EIP-7702 authorization method only when `delegationNeeded`, validate it with `validateDelegation`, and separately sign `result.payment` with `signNativePayment`. Use `buildAccountPayment(result.payment, signature)` for the zero-value outer transaction. Call `simulateRouterPayment` with the actual Broadcaster sender and optional signed `authorizationList`, then `relayEnvelope(coreCalldata, outer, authorizationList)` and `hashRelayEnvelope` with that same list.

The Router nonce, account action nonce, EOA transaction nonce and EIP-7702 authorization nonce are independent. An existing matching delegation needs no new authorization tuple. Chain/wallet EIP-7702 support must be confirmed by the host and the complete type-4 simulation; this package does not install, replace or revoke delegation. A delegation can persist even if payment execution reverts. `prepareNativeAccountPayment` reads state for preparation; repeat simulation immediately before submitting because nonce, registry and chain state can change.

`relayEnvelope` emits `{data: embeddedCoreCalldata, router:{to,data,value:"0",authorizationList?}}`. Signed authorization integers use geth JSON quantities. `hashRelayEnvelope` matches Go's `EnvelopeHash` and binds chain, Core, outer target, zero value, calldata and ordered authorizations under `payment-router-envelope-v1`. Execute the quoted outer transaction unchanged. Relay only accepts `payTokenFor` or a sponsored-native account call.

## Legacy native-only deployments

The following workflow uses the old `NativePaymentRouter` / `ZeroExNativePaymentRouter` contracts. `buildPaymentTransaction` and `simulatePayment` remain legacy APIs; use the canonical APIs above for unified PaymentRouter deployments. Their ABI is exported as `legacyNativePaymentRouterAbi` and `zeroExPaymentRouterAbi`.

```sh
pnpm add @invisi-labs/payment-router ethers
```

Create `PaymentRouterClient({ provider, deployment })` with verified chain, Router, core, WETH and Uniswap Router addresses. For 0x, also configure `deployment.zeroEx.allowanceHolderAddress` and `settlerRegistryAddress`. An optional `runtimeCodeHash` pins the Router runtime. On-chain getters and dependencies are verified before preparation, quoting, encoding and simulation.

1. Create explicit `NoteOutput` objects with the existing SDK. Current pure funding requires at least two outputs.
2. Call `client.preparePayment({ invisi, wallet, protocol, tokenAddress, outputs, fee?, deadline? })`. It binds the Router as funding payer with zero private inputs. Funding includes the output sum and optional same-token protocol fee.
3. Run the returned `PreparedTransaction` proving lifecycle. Obtain a fresh quote after proving.
4. Call `client.quote(adapter, { tokenOut, amountOut, maxInput, deadline, slippageBps? })`. Amounts and Unix deadlines use `bigint`; `amountOut` must equal `prepared.preview().funding.amount`.
5. Build with `client.buildPaymentTransaction({ payment: ready, quote, refundRecipient })`, then call `client.simulatePayment(call, { from })` with the actual submitting wallet.
6. Have the host wallet send the returned `{ to, data, value }`. `value` is the native swap budget; the wallet also needs gas. Unused native input is refunded by the contract to `refundRecipient`.

`UniswapV3Adapter({ provider, quoterAddress, routes })` accepts forward token arrays beginning at WETH and ending at the requested token, with one fee per hop. It quotes each configured route through QuoterV2, rounds the input ceiling up using integer arithmetic, and selects the cheapest executable candidate. Only original V3 router semantics are supported.

`ZeroExAdapter({ transport })` accepts an asynchronous quote transport. Browser applications should use their own backend proxy. `createZeroExQuoteFetcher({ apiKey, endpoint?, fetch? })` provides an explicit backend HTTP transport; never expose its API key in a browser bundle. The response must provide native `sellToken`, exact `buyAmount`, `maxSellAmount`, and payable `transaction`. Its recipient, native budget, deadline and Settler must satisfy the deployed Router contract. The client rejects incompatible quotes instead of rewriting their actions. Ordinary minimum-output or surplus-producing quotes may revert. HTTP transport availability does not guarantee the API will provide a compatible exact-buy quote.

Quotes may be refreshed without regenerating the core proof when the target token and funding amount stay fixed and the proof remains valid. Returned quotes are checked against fresh chain time and the current Settler registry. Simulate again before submission; state may change afterward.

ERC20 sell input, WETH output, private-input swaps, cross-chain settlement, Permit2 and asynchronous orders are outside this release. The host retains signing, proof execution, transaction submission and confirmation tracking.

See the workspace `examples/08-payment-router/` scenarios. Public ABI snapshots match `invisi-periphery` revision `b246f29`. Run `pnpm sync:payment-router-abis --check` from the workspace with the sibling contracts built to verify ABI identity. Optional Anvil contract tests use external liquidity and proof-verification doubles; live API quotes and genuine ZK proving require separate integration acceptance.

## Cross-SDK validation

The workspace golden vectors in `test-support/payment-router/vectors.json` cover reversed paths, native 0x acceptance and rejection, complete Router calldata and simulation accounting. Go and Rust consume the same bytes. Run `UPDATE_PAYMENT_ROUTER_VECTORS=1 pnpm --filter @invisi-labs/payment-router exec vitest run src/parity-vectors.test.ts` only when deliberately updating the reviewed reference.

The shared canonical intent vectors cover all four modes and account signing; envelope vectors include the Go-generated nonempty signed authorization list. Owned-Anvil tests execute all four canonical modes through V3, actual EIP-7702 delegation, the ERC20 0x Holder flow, and three legacy native channel variants. They use real Router/account bytecode, Core/proof and liquidity boundary doubles, verify token movement and cleared allowances, and reject nonce replay.

Run contract execution tests with `INVISI_PERIPHERY_REPO=/path/to/invisi-periphery pnpm --filter @invisi-labs/payment-router exec vitest run src/contracts.integration.test.ts`. Build Periphery contracts first. The tests execute V3, direct 0x and Holder-wrapped 0x payments and reject failed Core settlement with full rollback. They use real Router bytecode with Core and external liquidity doubles on an owned Anvil chain.

`scripts/payment-router-test-chain.mjs` provisions a separate loopback Anvil fixture for each native SDK using only public development accounts. Pass the Periphery checkout and a temporary output JSON path, then set `INVISI_PAYMENT_ROUTER_FIXTURE` to that file for the native SDK integration test. Stop the fixture process to close its owned chain.
