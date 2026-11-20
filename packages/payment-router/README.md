# @invisi-labs/payment-router

Optional atomic native-ETH swap payments for Invisi. Supports original Uniswap V3 exact-output routes and compatible native 0x Settler / AllowanceHolder payloads. Requires separately deployed `invisi-payment-router` contracts; this package does not deploy, sign or broadcast transactions.

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

See the workspace `examples/08-payment-router/` scenarios. Public ABI snapshots match `invisi-payment-router` revision `b246f29`. Run `pnpm sync:payment-router-abis --check` from the workspace with the sibling contracts built to verify ABI identity. Optional Anvil contract tests use external liquidity and proof-verification doubles; live API quotes and genuine ZK proving require separate integration acceptance.
