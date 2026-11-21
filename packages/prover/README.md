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

Core and Provenance are independently pinned. All Core circuits, including initial-payment, use the Core-only set; Provenance uses the Periphery set. Provision the two catalogs separately into the same verified cache:

```sh
node scripts/sync-prover-assets.mjs --set core --source ../invisi-core/.tools/core-assets
node scripts/sync-prover-assets.mjs --set provenance --source ../invisi-periphery/.tools/provenance-assets
```

Generate each source directory with that producer's `scripts/prover-assets.mjs` and an empty output directory. The provisioner checks the reviewed index pin and every selected object before writing the cache. Omit `--source` only after the corresponding release is published.

`new NativeProver({ resources: { directory: coreCatalog, provenanceDirectory: provenanceCatalog, offline: true } })` uses separate local catalogs. Use `baseUrls` and `provenanceBaseUrls` for separate mirrors; custom locations cannot replace the trust pins. Browser/WASM options support the same independent URL lists and a shared `ResourceCache`.

For historical combined catalogs, set `resources.release = "legacy"` and provision with `--set legacy` and `--set legacy-initial-payment`. Legacy mode is explicit and never an automatic retry. The historical extra set is needed only for legacy initial-payment.

The new split sets are locally verified and must be independently published before SDK release. CI provisions Core and Provenance separately and fails if either required release is missing.


## Verification keys and aggregation

Circuit metadata contains reviewed key identities and recursive commitments. Full
`vkHex` and `vkFields` payloads are no longer bundled. Native and WASM backends
load verification key binaries from the authenticated resource catalog on demand;
constructing a prover or aggregator performs no resource I/O. Existing Core assets
already contain these binaries. Periphery continues to publish the independent
Provenance resource set; neither producer requires a circuit or resource-format change.

```ts
import { NativeProver } from "@invisi-labs/prover/native";
import { Aggregator } from "@invisi-labs/prover/aggregate";

const prover = new NativeProver({
    resources: { directory: coreCatalog, offline: true },
});
const aggregator = new Aggregator({ prover });
const aggregate = await aggregator.aggregate(members, { signal });
```

Aggregation uses the backend's optional `loadVerificationKey(name, target, options)`
capability, retaining its configured resource locations, cache, offline policy and
explicit legacy selection. For custom provers without this capability, pass
`new Aggregator({ prover, resources })` to configure the browser-compatible asset
loader fallback. The backend capability takes precedence over that fallback.

Each required recursive key is loaded once per aggregation call. The binary's
SHA-256 identity, 115 canonical field words and Poseidon recursive commitment are
checked before witness assembly. Member proofs and the resulting aggregate still
undergo independent cryptographic verification. Calls support cancellation through
`ProverOptions.signal`; cached assets remain subject to integrity checks.

Consumers previously reading `getCircuitKey(...).vkHex` or `.vkFields` must use
asynchronous key loading instead. `getCircuitKey` now returns metadata only;
`prover.loadVerificationKey` returns binary bytes, not decoded witness fields.
New producer releases do not change the SDK's reviewed resource pins automatically.
