# @invisi-labs/payment-router

The canonical Router/account and relay APIs described here are unreleased source-workspace APIs planned for 1.3.3. Package manifests remain at 1.3.2; this guide does not imply npm 1.3.2 contains them.

Atomic native/ERC20 payments for the canonical `invisi-periphery` PaymentRouter (unified Router/account ABI; legacy snapshots are separately exported). Supports direct native, direct ERC20, signed relayed ERC20 and delegated-account sponsored native payments. Core proofs and settlement remain unchanged. Wallet keys and transaction submission remain host-provided.

## Canonical PaymentRouter and pre-proof quotes

Use `paymentRouterAbi` and `paymentRouterAccountAbi` for the unified deployment. `preparePayment` binds Core funding to the Router and includes both Note outputs and the Core token fee. Wallet keys, proof execution and explicit transaction submission remain host-controlled.

The relay lifecycle is **prepare draft → local estimate → service fee estimate → rebuild unsigned final fee/route → formal quote → prove → sign actual call → submit**. A formal `payment-router-intent-v1` quote requires the final business fields, including Core fee, outputs/deliveries, input cap, route, deadlines and every nonce. It requires no proof or wallet signature. An approved fee may exceed the service floor; never exceed the host's fee or input caps. If a fee rebuild changes the required output amount, refresh the exact-output swap route before the formal quote. There is no automatic fee increase, broadcast or convergence guarantee.

```ts
const prepared = await client.preparePayment(preparation);
const draft = await client.prepareRouterPaymentDraft({
  payment: prepared, payer, tokenIn, mode: PaymentMode.RelayedToken,
  refundRecipient: payer, relayer, deadline, amountInMaximum: maxInput,
  // quote: exact-output swap quote when input differs from Core token
});
const coreIntent = await prepared.exportBroadcasterIntent();
const draftInput = {coreCalldata: coreIntent.data, outer: buildRouterPaymentDraft(draft)};
const baseline = prepared.estimateGas();
if (!baseline.available) throw new Error("Core preview unavailable");
const local = estimateRouterPaymentGas(draft, baseline.gasUnits);
const estimate = await relay.estimateRouterFee(draftInput);
if (approvedCoreFeeAmount < BigInt(estimate.feeAmount) || approvedCoreFeeAmount > maxFeeAmount)
  throw new Error("Approve a fee covering the floor within the cap");
// If the provisional fee differs, call preparePayment with the approved final fee,
// refresh the swap route and prepareRouterPaymentDraft again. No proving is needed.
const signedQuote = await relay.getQuote(finalDraftInput);
const ready = await finalPrepared.prove();
const coreCall = await ready.exportTransaction();
const actual = finalizeRouterPayment(finalDraftPayment, coreCall);
actual.signature = await signPaymentIntent(signer, chainId, routerAddress, actual.intent);
const input = {coreCalldata: coreCall.data, outer: client.buildRouterTransaction(actual)};
await client.simulateRouterPayment(input.outer, {from: relayer});
// Persist input + signedQuote. Explicitly submit only after host review:
// const submission = await relay.submitTransaction(input, signedQuote);
```

`prepareRouterPaymentDraft` accepts an unproved `TransactionCall` or the normal SDK `PreparedTransaction`; it uses that transaction's existing `exportBroadcasterIntent()` without fake proof bytes. `prepareRouterPayment` still requires an actual proof. `buildRouterPaymentDraft` and `buildAccountPaymentDraft` encode quote-only calls. `buildRouterPayment` requires a proof and the relayed-token signature. `finalizeRouterPayment` requires identical Core business fields and rebuilds the actual proof-dependent Router intent hash before signing. The Core fee/route cannot change after the formal quote.

`estimateRouterGas` consumes `coreGasUnits`, numeric `mode` (0–3), `channel` (0–2), `hopCount`, `routeBytes`, `permit`, `authorizationCount` and optional `zeroExGasUnits`. `estimateRouterPaymentGas` derives these Router fields from a payment, taking the existing Core gas preview as its baseline. Results use `source: "model"`, `modelId: "payment-router-gas-v1"`, and either `available/gasUnits/breakdown` or an unavailable reason. The shipped shared JSON profile contains conservative engineering allowances, not measured swap benchmarks. The common Core transaction base is counted once. V3 supports 1–8 hops; no-swap routes carry no route bytes/hops. Opaque 0x routes require an independently trusted positive route gas budget; otherwise the preview is unavailable. The service independently configures its own budget and does not trust client gas hints. A model preview is not an RPC simulation or transaction gas limit.

For native input use `tokenIn: ZeroAddress`. `prepareNativeAccountPayment` checks the pinned implementation, Router/code hash and current account action nonce; it refuses a foreign installed delegation. Supply the persisted action nonce when undelegated (`0n` only for a known fresh account; revocation preserves action storage). Build the unsigned account draft with `buildAccountPaymentDraft`. If delegation is needed, include `unsignedDelegation(result.authorizationRequest)` in the draft authorization list: its chain, delegate and EOA nonce are bound, while its signature remains empty. Obtain the formal quote, prove, rebuild the actual Router call and replace `result.payment.routerCall`, then sign `signNativePayment` and the exact EIP-7702 authorization request. Build the actual outer call with `buildAccountPayment`, simulate with the signed authorization list, and explicitly submit using the same quote. A matching installed delegation requires no authorization tuple. Router intent nonce, account action nonce, payer EOA authorization nonce and Broadcaster outer transaction nonce are distinct. The host coordinates pending payer transactions; the SDK never replaces foreign delegation or broadcasts a delegation change.

Direct native/token modes use the payer wallet and no Broadcaster. ERC20 input needs Router allowance (`inputAllowance`/`inputApproval`) or an ERC-2612 permit (`inputPermitTypedData`/`signedInputPermit`). Set the permit deadline in the draft before quoting; its signature can follow the quote. Permits and allowance do not replace the Router intent signature. Native `value` is the maximum input; sponsored native wraps this inner call in a zero-value account outer call. Omit the swap quote for same-token funding or native-to-WETH wrapping.

## Broadcaster RPC

Construct `PaymentRouterRelayClient` with an HTTPS endpoint and independently trusted `chainId`, `core`, `quoteSigner` and `feeRecipient`. Discover enabled deployments and the actual fixed relayer through `broadcaster_getStatus` / `broadcaster_getTokenSupport`. The normal Core `BroadcasterClient` uses a different request hash and must not verify Router quotes.

`estimateRouterFee` (alias `estimateQuote`) and `getQuote` send canonical draft `{data,router:{to,data,value:"0",authorizationList?}}` through `broadcaster_estimateQuote` and `broadcaster_getQuote`. `submitTransaction` sends the actual proved/signed envelope plus `quote` and `signature` through `broadcaster_submitTransaction`; it rejects empty proof/player signatures and verifies the quote again. The service validates actual Core/route hashes, wallet signatures, deployment and live nonces, and estimates/simulates the full final outer call within signed gas and fee caps.

`hashRouterIntent` strictly decodes canonical relay ABI and recomputes the existing raw envelope hash after clearing the Core proof and rebuilding its Core request hash, clearing Router/account and permit signatures (retaining permit deadline), and clearing EIP-7702 signature limbs (retaining ordered chain/delegate/nonces). It wraps that normalized hash under `InvisiPaymentRouterIntentV1`. Every other business field remains bound. Embedded Core calldata must match its own outer call at both draft and final stages. `verifyRouterBroadcasterQuote` derives the identity locally and accepts `payment-router-intent-v1` plus explicit legacy `payment-router-envelope-v1` records. `hashRelayEnvelope` remains the raw-envelope identity/debug utility and legacy quote hash. `relayDraftEnvelope` permits unsigned metadata; `relayEnvelope` requires an actual proof and signatures. Relaying supports only `payTokenFor` or account-wrapped sponsored `payNative`.

Quote verification pins the settlement token, exact Core fee and recipient, quote signer, direct execution, and expiry within Core/Router/account deadlines. Proof and signature changes retain the new semantic quote; changing fee, route, payer, budget, nonces, deadlines, deliveries, delegation metadata or outer target requires another quote. Optional `provenanceRequired` is service capability metadata; pure Router funding sends no private-input sidecar. Authorization integer fields use minimal geth JSON quantities.

Persist the final input and signed quote before explicit submission; save the returned opaque `id` and query `broadcaster_getTransactionStatus` with `params:[{id}]`, polling with backoff. An uncertain acknowledgement must recover the original saved request and outcome, without automatic rebroadcast. The service uses semantic identity for new records and retains legacy identity for old records. This client's expiry verifier blocks expired replay; use the host RPC recovery interface for an already accepted expired record. Confirmed execution does not establish chain finality.

The [canonical host examples](../../examples/08-payment-router/03-canonical-host.ts) implement both token and native formal quote-before-proof flows, preserve host fee/input caps, and return reviewed calls without broadcasting.

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

For these legacy native-only APIs, ERC20 sell input and WETH output are unsupported. The canonical APIs above support both. Private-input swaps, cross-chain settlement, Permit2 and asynchronous orders remain unsupported. The host retains signing, proof execution, transaction submission and confirmation tracking.

See the workspace `examples/08-payment-router/` scenarios. The legacy ABI snapshots match `invisi-periphery` revision `b246f29`; canonical Router/account ABIs are exported separately. Run `pnpm sync:payment-router-abis --check` from the workspace with the sibling contracts built to verify ABI identity. Optional Anvil contract tests use external liquidity and proof-verification doubles; live API quotes and genuine ZK proving require separate integration acceptance.

## Cross-SDK validation

The workspace golden vectors in `test-support/payment-router/vectors.json` cover reversed paths, native 0x acceptance and rejection, complete Router calldata and simulation accounting. Go and Rust consume the same bytes. Run `UPDATE_PAYMENT_ROUTER_VECTORS=1 pnpm --filter @invisi-labs/payment-router exec vitest run src/parity-vectors.test.ts` only when deliberately updating the reviewed reference.

The shared canonical intent vectors cover all four modes and account signing; envelope vectors include the Go-generated nonempty signed authorization list. Owned-Anvil tests execute all four canonical modes through V3, actual EIP-7702 delegation, the ERC20 0x Holder flow, and three legacy native channel variants. They use real Router/account bytecode, Core/proof and liquidity boundary doubles, verify token movement and cleared allowances, and reject nonce replay.

Run contract execution tests with `INVISI_PERIPHERY_REPO=/path/to/invisi-periphery pnpm --filter @invisi-labs/payment-router exec vitest run src/contracts.integration.test.ts`. Build Periphery contracts first. The tests execute V3, direct 0x and Holder-wrapped 0x payments and reject failed Core settlement with full rollback. They use real Router bytecode with Core and external liquidity doubles on an owned Anvil chain.

`scripts/payment-router-test-chain.mjs` provisions a separate loopback Anvil fixture for each native SDK using only public development accounts. Pass the Periphery checkout and a temporary output JSON path, then set `INVISI_PAYMENT_ROUTER_FIXTURE` to that file for the native SDK integration test. Stop the fixture process to close its owned chain.
