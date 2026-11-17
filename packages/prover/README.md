# @invisi-labs/prover

Runtime-neutral proving interfaces with explicit native and WASM backends.

Install with `npm install @invisi-labs/prover@1.2.4`. API documentation and runnable examples are in the [SDK repository](https://github.com/invisi-lab/invisi-sdk-ts).

## Contributing

See the [contribution guidelines](../../README.md#contributing) for issues, pull requests, validation, and handling sensitive material.

The default disk cache is the system cache directory plus `invisi/prover-assets`:
`~/Library/Caches/invisi/prover-assets` on macOS,
`${XDG_CACHE_HOME:-~/.cache}/invisi/prover-assets` on Linux, and
`%LOCALAPPDATA%/invisi/prover-assets` on Windows.
An explicit cache option overrides `INVISI_PROVER_CACHE_DIR`, which overrides this default.
Index files use `<index-sha256>.index.json`; objects use `<sha256>.json` or `<sha256>.vk`,
so Node, Go and Rust can share the same verified disk cache. Offline mode defaults to false.
