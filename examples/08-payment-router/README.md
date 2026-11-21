# Canonical Router scenarios

These standalone examples use the unreleased SDK workspace APIs. `04` through `08` run real Core proofs, simulate the final transaction, and explicitly submit with `--execute`. Their default invocation exits before accounts, environment keys, local prover checks or network access. With `--execute`, unconfigured deployment placeholders still fail before network access. The existing `01`/`02` legacy examples and importable `03-canonical-host.ts` retain their existing behavior.

Use the [common setup](../README.md#setup): public account profiles in `accounts/accounts.json`, `settings.ts` for chain ID/RPCs/Barretenberg, and an externally supplied `ALICE_PRIVATE_KEY` matching Alice's public payer address. No private key belongs in account JSON. Configure each script's deployment addresses from independently reviewed records. The Protocol RPC's Core address must match the pinned Core address. The configured default chain is 97; choose a chain with the required deployments and wallet/RPC capabilities before execution. A placeholder is not a deployment claim.

| Script / command | Principal and payer | Execution |
| --- | --- | --- |
| `04-self-token.ts` / `example:payment-router:self-token` | Alice's ERC20, same as the Core output token | Router allowance, real Core proof, payer simulation, Alice sends and pays gas |
| `05-self-native-v3.ts` / `example:payment-router:self-native` | Alice's native balance, wrapped then swapped into the Core token | Real V3 QuoterV2 exact-output quote, real Core proof, simulation, Alice sends |
| `06-relayed-token.ts` / `example:payment-router:relayed-token` | Alice's ERC20 principal and Core-token service fee | Fee estimate and approved final fee, formal unsigned quote, proof, Router allowance, payment intent signature, relay simulation, explicit relay submission |
| `07-sponsored-native-7702.ts` / `example:payment-router:7702` | Alice's delegated EOA native balance | V3 exact-output swap, quote binding action/delegation nonces, Core proof, EIP-7702 authorization and account action signature, simulation, relay submission |
| `08-self-token-zeroex.ts` / `example:payment-router:zeroex-token` | Alice's input ERC20, swapped into a different Core token | Trusted backend's real 0x exact-buy response, SDK validation, proof, Router allowance, simulation, Alice sends |

```sh
pnpm --filter @invisi-examples/scenarios example:payment-router:self-token --execute
pnpm --filter @invisi-examples/scenarios example:payment-router:self-native --execute
pnpm --filter @invisi-examples/scenarios example:payment-router:relayed-token --execute
pnpm --filter @invisi-examples/scenarios example:payment-router:7702 --execute
pnpm --filter @invisi-examples/scenarios example:payment-router:zeroex-token --execute
```

All five create two real encrypted Note outputs. They consume no old private Notes: canonical Router public funding still needs a Core proof, but has no private input requiring a Provenance input proof. The separate `shield` interface has different proof requirements. Later spending these Notes is covered by [Router recognition and private Note spending](../09-router-provenance/README.md).

The direct examples deliver 0.003 Core tokens to Bob and 0.007 to Alice. The relayed ERC20 example adds an explicitly approved 0.001-token Core fee, capped at 0.002. It stops if the live fee floor exceeds that approved amount, without raising the fee or retrying automatically. Review the input and fee budgets for your actual token decimals and service.

The 7702 example delivers **Bob 100 + Alice 0.1 + Core service fee 0.1 = 100.2 target tokens**. Native principal buys that exact output through V3, under a separately approved native input cap. The Core token must differ from WETH. The quote is obtained before proof generation or wallet signatures; it binds the final route, fee and nonce/delegation metadata. No fabricated quotes, proof bytes, calldata or signatures are used.

Pin the Broadcaster endpoint, quote signer, fee recipient and relayer independently. The relay SDK verifies signed quotes against that scope and the unsigned semantic intent. Service submission validates the final proof/signatures and current account state again. The local Router gas value is a conservative model, not a measured swap benchmark or a service fee promise. An installed matching delegation needs no new authorization tuple. Set the persisted undelegated action nonce from trusted local records; `0n` is valid only for a known fresh account. Revoking delegation does not reset it, foreign delegation is not automatically replaced, and delegation can survive a failed payment. The chain, provider and signer must support EIP-7702 and simulation with authorization lists.

For V3, configure the trusted QuoterV2, swap router, WETH and a real liquid fee-tier route. For 0x, configure the reviewed AllowanceHolder and Settler registry plus your own HTTPS backend returning the raw service quote. The API key stays on that backend. The SDK validates the response; the payer approves only the Router, never a target copied from the quote. Native refunds and unused input follow the Router intent's explicit refund recipient.

Record the relay submission ID and returned state. Use `broadcaster_getTransactionStatus` with `params: [{ id }]` through your host transport; `submitted`, `uncertain` and a returned transaction hash do not establish final confirmation. Recover using the saved input/quote and ID rather than constructing another payment. For persistent host integration without automatic submission, use `03-canonical-host.ts` and save its returned input and signed quote before explicit submission.
