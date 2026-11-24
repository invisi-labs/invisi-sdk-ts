# Develop integration

Integrated optimization safety commit `5b9ab52` with develop `53127a2` (fee locks and receiving-signature-v1). Both Ethers gate helpers and receiving-key exports remain; both the detached persistence race test and upstream frozen-tariff test remain.

Fee-lock preparation now supports authenticated startup capability discovery and valid ticket reuse, without caching mutable submission halt/provenance requirements. Registry token-support responses prime capability state without another status query. Explicit clients can use `Protocol.initializeBroadcasters({tokenAddress, clients})` or `client.prepareCapabilities(context)`.

The bounded client caches fence configuration/transport/method identity, capability generations and ticket acquisition. Expired tickets refetch; delayed failures evict only the exact originating retained generation, including identical signed ticket bytes. Stale legacy-capability results and old pending acquisitions cannot publish across refreshed support. Advertised fee-lock failures do not downgrade. Independent cache review is GREEN; race regressions and expiry/signature/binding controls passed.

Verification on the integrated feature tree: all ten TS packages, 1,932 passed and 42 conditional skips, 21/21 build/test tasks; type/build sweep22/22. Format, package ESM/CJS interoperability, session/module boundaries and WASM passed. The session-runtime CI fixture now recognizes no-parameter getStatus capability discovery instead of decoding missing calldata.

The same initialized ordinary HTTP driver ran3fixtures with2operations each: each operation remains7pre-broadcast HTTP reads (prepare2, quote2, signature0, submit3). Both nonces7/14 enter final authorization, the first journal remains intact after the second, and6writes are denied before HTTP. Explicit configured capability initialization costs1getStatus per fixture and is reported outside the transaction; it is not hidden in quote. RPC support priming tests separately prove token-support initialization needs no duplicate status query.

Go and Rust integrate into their own develop branches separately. Full logs, raw parameters, cache review and integration proof remain under `/tmp/invisi-sdk-integration-20261125`; generated logs and historical bulk sampling snapshots are intentionally not staged. Native proof/live conditional tests remain skipped. Browser size remains the previously reported budget exception; no browser threshold or validation policy was relaxed. No push or public-chain broadcast was performed.
