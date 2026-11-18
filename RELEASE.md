# SDK 1.2.7 release preparation

All nine public packages form one fixed `1.2.7` release. Package versions are separate from the unchanged Protocol RPC API v1, on-chain Protocol version 1 and current authenticated circuit manifests. No package is published by the checks below.

```sh
pnpm install --frozen-lockfile
python3 scripts/sync-provenance.py --check-package packages/prover/src/resources
pnpm build
pnpm lint
pnpm exec turbo run test --concurrency=1 -- --maxWorkers=2 --minWorkers=1
node --test scripts/check-release.test.mjs scripts/publish-release.test.mjs scripts/provenance-assets.test.mjs scripts/release-archive.test.mjs
node scripts/check-release.mjs v1.2.7
```

Pack each `packages/*` package into a separate temporary directory with `pnpm --dir <package> pack --pack-destination <directory>`, then validate it:

```sh
node scripts/check-release.mjs v1.2.7 /tmp/invisi-release-packages
node scripts/check-packed-release.mjs v1.2.7 /tmp/invisi-release-packages
```

The packed consumer check validates every declared export and exact sibling dependency, installs all nine archives in a temporary consumer, imports ESM/CommonJS entry points and typechecks all public subpaths. Sibling overrides resolve unpublished versions only to the supplied archives; archive manifests must already declare exact `1.2.7` dependencies. Third-party dependencies may be fetched read-only from the npm registry, preferring the existing package cache. The consumer uses the repository's pinned pnpm version.

Provenance cache behavior is shared across TS, Go and Rust: validate retained public evidence locally and reuse it without chain reads, Source requests or a prover. Explicit reproof refreshes evidence using the retained original operation; it does not recreate or mutate the payment. Final RPC gas estimates use final calldata and caller and remain distinct from gas benchmark references and relay fees. Token-filtered broadcaster discovery probes authenticated operator capability after pinned registry pagination; no token field is added to the Protocol RPC pagination method.

Publishing requires a separate authorization. These preparation steps do not create Git tags, push branches or run the publishing script.

Public circuit JSON and VK resources are published independently by Core. The SDK pins one immutable resource index and loads only required files, verifying size and hash before use. Publish that exact resource set before publishing SDKs; validate a cold-cache load. Native binaries and upstream WASM/CRS remain separate from the circuit snapshot.

`releases/v1.2.7/npm-integrity.json` records the immutable canonical tarball SHA-512 values. Existing versions are skipped only after both registry metadata and downloaded archive bytes match that list, and the fresh build matches every runtime, declaration and resource file. Frozen CommonJS sourcemap build-directory fields and JSON property ordering are reported separately; other sourcemap or metadata changes fail verification. New publication requires the built archive itself to match the canonical SHA-512. A version already accepted for npm processing is never automatically published again while its public metadata is absent. GitHub release assets retain the canonical tarballs and integrity list.

Release notes use the local versioned CHANGELOG as the only maintained source.
`scripts/release-notes.py vMAJOR.MINOR.PATCH --output NOTES.md` renders the complete
current entry (all public package entries for TypeScript) into the GitHub Release
body. Missing, duplicate, empty or link-only entries fail validation before
publication. Historical entries are retained locally; a release body includes only
its matching version. Release retries update the same body from the same source.
