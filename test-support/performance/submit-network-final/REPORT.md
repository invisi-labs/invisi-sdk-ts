# TS submission network fence: eight reads to seven

Historical benchmark at safety commit `5b9ab52`, before integrating develop receiving-signature-v1 and fee locks. Source fingerprints below deliberately identify that measured snapshot. See `integration.md` for merged verification.

The extra request was `eth_chainId` with empty params `[]` in the end-of-validation check **before** persistence. Managed first send then performed another real identity read **after** persistence. The former completion read can be merged into the latter for the stock, observed, self-contained Shield path.

## Result

| Stage | Before HTTP | After HTTP |
|---|---:|---:|
| Prepare | 2 | 2 |
| Quote | 2 | 2 |
| Funding authorization/signature | 0 | 0 |
| Submit through denied write | 4 | 3 |
| Total before broadcast | 8 | 7 |

The seven calls are prepare `eth_chainId([])` and `eth_call` for `nonces(payer)`; quote `broadcaster_estimateQuote` and `broadcaster_getQuote`; submit `broadcaster_getStatus([])`, entry `eth_chainId([])`, and terminal `eth_chainId([])` after durable persistence. Each raw JSON includes the actual request params, encoded calldata and signed quote inputs for public synthetic payers. A real broadcaster send adds its own HTTP request and service time; it is denied at the innermost transport in this diagnostic.

Three fixtures per variant, two consecutive operations per fixture, fee 5/cap 10, embedded recipient and nonces 7/14. HTTP responses have fixed 20 ms delay. Both variants use the identical existing unified driver with `SUBMIT_HTTP_STAGE_CONTRACT=1`; cold setup/initialization is charged separately and remains 20/0 HTTP per fixture. Before/after code is isolated by source snapshot; the only baseline source overlay is the current regression test file for RED checks, not production.

| Median across six operations | Before ms | After ms |
|---|---:|---:|
| Submit through denied write | 128.10 | 91.33 |
| Prepare-to-submit stage sum | 266.42 | 229.95 |

All six before operations use 8 HTTP reads and three submit chain IDs; all six after operations use 7 reads and two submit chain IDs. The first journal remains byte-identical after the second operation. These controlled loopback timings do not represent public-chain completion times; request counts are the stable result.

## Safety boundary

Only the managed caller that captures post-persistence authority can defer network completion. The capability must match the exact runtime and chain. Entry still performs a network check; temporary scope, provider/event epoch and policy identities are checked synchronously after deployment validation. The real final chain-ID read remains after durable commit, followed by the unchanged wallet mutation observer, attempt-token/reservation/policy checks and stock transport handoff.

Manual export/standalone validation and custom/unobserved readers retain their previous complete checks. No chain-ID cache or generic skip-network boolean was introduced. The durable packet, signatures, uncertainty and reservations remain available when final checks reject; unknown-ID recovery replays exactly, and known-ID recovery only queries status.

## Verification

- RED: original initialized managed path reads entry + pre-store completion + post-store identity; the regression expects only entry + post-store identity.
- RED/GREEN: real authorities from a different runtime or captured chain reject with listener cleanup.
- 94/94 submission-scope tests passed, including blocked persistence, eventless switching, wallet writes during final RPC, persistence errors, exact replay and known-ID status-only recovery.
- Full TS workspace: 1,894 passed, 42 conditional skips; 21/21 build/test tasks. Type/build sweep: 22/22 tasks. Public ESM/CJS surface, session/module boundaries and WASM passed.
- Independent review GREEN (`results/review.md`). Four production files changed; one regression test file was extended.
- Browser gate remains above the inherited 1 MiB budget: 1,294,304 bytes, compared with 1,294,233 before. The budget was not relaxed. An early surface check was invoked during build cleanup and saw a missing SDK dist entry; the sequential final surface check passed. The older generated Chinese performance report remains the previously reported English-lint exception; no remote CI success is claimed.

Committed result summaries include stage medians, source fingerprints, validation and review. Raw request/parameter JSON, exact commands, RED/GREEN and full verification logs are retained locally under `results/` and `/tmp/invisi-ts-submit-final-fence-20261125`. Previous Go/Rust seven-read results are unchanged reference data from the prior stage-boundary diagnostic; this run changes and measures only TS. These measurements preceded the integration commit; no public-chain broadcasts were made.
