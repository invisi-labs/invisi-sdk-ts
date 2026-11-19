# @invisi-labs/prover

Runtime-neutral proving interfaces with explicit native and WASM backends.

Install with `npm install @invisi-labs/prover@1.2.7`. API documentation and runnable examples are in the [SDK repository](https://github.com/invisi-labs/invisi-sdk-ts).

## Contributing

See the [contribution guidelines](../../README.md#contributing) for issues, pull requests, validation, and handling sensitive material.

The default disk cache is the system cache directory plus `invisi/prover-assets`:
`~/Library/Caches/invisi/prover-assets` on macOS,
`${XDG_CACHE_HOME:-~/.cache}/invisi/prover-assets` on Linux, and
`%LOCALAPPDATA%/invisi/prover-assets` on Windows.
An explicit cache option overrides `INVISI_PROVER_CACHE_DIR`, which overrides this default.
Index files use `<index-sha256>.index.json`; objects use `<sha256>.json` or `<sha256>.vk`,
so Node, Go and Rust can share the same verified disk cache. Offline mode defaults to false.

WASM runtimes remain the pinned upstream npm dependencies, separate from Core's
circuit JSON/VK resource snapshot. Importing the neutral, WASM or Provenance entry
and constructing a prover do not import Noir or Barretenberg. Noir loads when
witness generation starts; Barretenberg loads when proving or verification starts.
Browser applications must preserve dynamic chunks and deploy the dependencies'
WASM files according to their bundler's asset handling. Lazy loading does not
remove those files from npm installations or the application's deployment output.

`wasmPath` selects the Barretenberg runtime source: a URL in browsers and a local
file path in Node. The upstream browser loader derives the `-threads` filename
when using shared-memory WASM; the configured location must provide that variant.
This option does not relocate ACVM or ABI WASM, nor does it authenticate a custom
runtime URL against the Core circuit index. No custom CDN is enabled by default.
CRS parameters retain the upstream official CDN and fallback behavior.
`resources.offline` only disables circuit/VK resource downloads: it does not make
upstream WASM initialization or CRS access offline automatically.

The atomic Credit initial-payment circuit has a separate authenticated resource set.
Until Core publishes it, build the set from the matching Core checkout and provision
the two initial-payment objects into your local cache:

```sh
# In invisi-core, after generating the release verifiers and keys:
node scripts/prover-assets.mjs .tools/initial-payment-assets

# In invisi-sdk-ts:
node scripts/sync-prover-assets.mjs --set initial-payment --source ../invisi-core/.tools/initial-payment-assets \
  --path circuits/create_credit_initial_payment.json --path circuits/create_credit_initial_payment.evm.vk
```

Existing circuits keep using their original resource set.

Real proof suites include `create_credit_initial_payment` whenever native or WASM proving
is enabled. CI provisions both the base (`ca3ee…`) and initial-payment (`9161…`)
sets independently and fails if either download or proof is unavailable. The
initial-payment set is not yet published; this CI prerequisite remains outstanding.
For deliberate local offline development only, `INVISI_SKIP_INITIAL_PAYMENT_PROOFS=1`
skips that circuit; CI rejects this setting. To run all real proofs locally,
provision both sets, set `BB_BINARY_PATH` for native tests and `INVISI_TEST_WASM=1`
for browser-entry WASM tests. The SDK's `NativeCreditTransaction.test.ts` also runs
owner-signed prepared initial-payment proofs under either setting, without another opt-in.
