# SDK 1.2.0 release preparation

All eight public packages form one fixed `1.2.0` release. Package versions are separate from the unchanged Protocol RPC API v1, on-chain Protocol version 1 and current authenticated circuit manifests. No package is published by the checks below.

```sh
pnpm install --frozen-lockfile
python3 scripts/sync-provenance.py --check-package packages/prover/provenance
pnpm build
pnpm lint
pnpm exec turbo run test --concurrency=1 -- --maxWorkers=2 --minWorkers=1
node --test scripts/check-release.test.mjs scripts/publish-release.test.mjs
node scripts/check-release.mjs v1.2.0
```

Pack each `packages/*` package into a separate temporary directory with `pnpm --dir <package> pack --pack-destination <directory>`, then validate it:

```sh
node scripts/check-release.mjs v1.2.0 /tmp/invisi-release-packages
node scripts/check-packed-release.mjs v1.2.0 /tmp/invisi-release-packages
```

The packed consumer check validates every declared export and exact sibling dependency, installs all eight archives in a temporary consumer, imports ESM/CommonJS entry points and typechecks all public subpaths. Sibling overrides resolve unpublished versions only to the supplied archives; archive manifests must already declare exact `1.2.0` dependencies. Third-party dependencies may be fetched read-only from the npm registry, preferring the existing package cache. The consumer uses the repository's pinned pnpm version.

Provenance cache behavior is shared across TS, Go and Rust: validate retained public evidence locally and reuse it without chain reads, Source requests or a prover. Explicit reproof refreshes evidence using the retained original operation; it does not recreate or mutate the payment. Final RPC gas estimates use final calldata and caller and remain distinct from gas benchmark references and relay fees. Token-filtered broadcaster discovery probes authenticated operator capability after pinned registry pagination; no token field is added to the Protocol RPC pagination method.

Publishing requires a separate authorization. These preparation steps do not create Git tags, push branches or run the publishing script.

The seven Provenance tiers ship as 14 public compiled artifacts and verification keys, versioned beside the pinned manifest. Release CI authenticates their manifest pin, individual SHA-256 hashes and exact file inventory before packing; witness data is not part of this asset set. To update the release, authenticate a current protocol checkout with `python3 scripts/sync-provenance.py <protocol-root>` and review the manifest/pin and all public resource changes together.

`releases/v1.2.0/npm-integrity.json` records the immutable canonical tarball SHA-512 values. Existing versions are skipped only after both registry metadata and downloaded archive bytes match that list, and the fresh build matches every runtime, declaration and resource file. Frozen CommonJS sourcemap build-directory fields and JSON property ordering are reported separately; other sourcemap or metadata changes fail verification. New publication requires the built archive itself to match the canonical SHA-512. A version already accepted for npm processing is never automatically published again while its public metadata is absent. GitHub release assets retain the canonical tarballs and integrity list.
