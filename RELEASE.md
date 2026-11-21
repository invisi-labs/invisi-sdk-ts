# SDK 1.3.3 release preparation

All ten public packages follow one fixed release version (currently `1.3.3` in workspace manifests). Package versions are separate from the unchanged Protocol RPC API v1, on-chain Protocol version 1 and current authenticated circuit manifests. No package is published by the checks below.

```sh
pnpm install --frozen-lockfile
python3 scripts/sync-provenance.py --check-package packages/prover/src/resources
pnpm build
pnpm lint
pnpm exec turbo run test --concurrency=1 -- --maxWorkers=2 --minWorkers=1
node --test scripts/check-release.test.mjs scripts/publish-release.test.mjs scripts/provenance-assets.test.mjs scripts/release-archive.test.mjs scripts/vk-metadata.test.mjs
python3 scripts/test_ci_reuse.py
python3 scripts/test_release_notes.py
pnpm check:browser
pnpm check:wasm
pnpm examples
pnpm check:surface
node scripts/check-release.mjs v1.3.3
```

Pack each `packages/*` package into a separate temporary directory with `pnpm --dir <package> pack --pack-destination <directory>`, then validate it:

```sh
node scripts/check-release.mjs v1.3.3 /tmp/invisi-release-packages
node scripts/check-packed-release.mjs v1.3.3 /tmp/invisi-release-packages
```

The packed consumer check validates every declared export and exact sibling dependency, installs all ten archives in a temporary consumer, imports ESM/CommonJS entry points and typechecks all public subpaths. Sibling overrides resolve unpublished versions only to the supplied archives; archive manifests must already declare exact `1.3.3` dependencies. Third-party dependencies may be fetched read-only from the npm registry, preferring the existing package cache. The consumer uses the repository's pinned pnpm version.

Provenance cache behavior is shared across TS, Go and Rust: validate retained public evidence locally and reuse it without chain reads, Source requests or a prover. Explicit reproof refreshes evidence using the retained original operation; it does not recreate or mutate the payment. Final RPC gas estimates use final calldata and caller and remain distinct from gas benchmark references and relay fees. Token-filtered broadcaster discovery probes authenticated operator capability after pinned registry pagination; no token field is added to the Protocol RPC pagination method.

Publishing requires a separate authorization. These preparation steps do not create Git tags, push branches or run the publishing script.

Public circuit JSON and VK resources are published independently by Core and Periphery. The SDK pins separate immutable Core and Provenance indices and loads files by capability, verifying sizes and hashes before use. Publish both exact resource sets before publishing SDKs; validate cold-cache loads for both capabilities. Native binaries and upstream WASM/CRS remain separate from the circuit snapshot.

The current Core catalog is `85a5d1dffe40fc965ab4345a28b632f463c3ad861c44d5845850fbc7447fd8f6`, from `invisi-labs/invisi-core` commit `4940be21de91689b59ba1a2fe46945f767c3a34c` (`prover-release-4940be21de91689b59ba1a2fe46945f767c3a34c`). The current Provenance catalog is `8d5a3e60e3e5cbe315150511207d7aff67f4e2924148d396b67d82017ecd1f1c`, from `invisi-labs/invisi-periphery` commit `33ba458ea11e07da282c21b8a2b091a0be1ebd01`. Public resources load from `https://assets.invisipay.fi/prover/sets/<index>/`; explicit legacy manifests and their pins remain historical.

Prepare the canonical archives on a trusted Linux runner with the manual `Prepare canonical SDK archives` workflow, using the exact commit already validated on `develop` or `main`. Retain its verified `canonical-npm-archives` artifact, commit its inventory to `releases/v1.3.3/npm-integrity.json`, and attach its exact `.tgz` files and inventory to a draft GitHub release before pushing the release tag. This preparation workflow does not publish packages. The first Payment Router registration must have npm publication authority configured before the fixed-cohort release starts.

`releases/v1.3.3/npm-integrity.json` records the immutable canonical tarball SHA-512 values. Existing versions are skipped only after both registry metadata and downloaded archive bytes match that list, and the fresh build matches every runtime, declaration and resource file. Frozen CommonJS sourcemap build-directory fields and JSON property ordering are reported separately; other sourcemap or metadata changes fail verification. New publication requires the built archive itself to match the canonical SHA-512. A version already accepted for npm processing is never automatically published again while its public metadata is absent. GitHub release assets retain the canonical tarballs and integrity list.

Release notes use the local versioned CHANGELOG as the only maintained source.
`scripts/release-notes.py vMAJOR.MINOR.PATCH --output NOTES.md` renders the complete
current entry (all public package entries for TypeScript) into the GitHub Release
body. Missing, duplicate, empty or link-only entries fail validation before
publication. Historical entries are retained locally; a release body includes only
its matching version. Release retries update the same body from the same source.


## CI result reuse

Push checks run on `develop` and `main`; pull requests targeting either branch remain checked. `main` reuses successful `develop` push CI only for the identical commit SHA. Tag releases reuse successful `develop` or `main` push CI for that exact SHA; otherwise they run verification before release. Running, cancelled, skipped and failed results are never accepted. API failures block release instead of granting reuse. New merge commits require their own checks. Publishing remains tag-only, with package/archive validation retained. Branch pushes do not create releases.

New npm publications wait for registry metadata and the tarball to become available, then verify package identity, version, metadata integrity and downloaded SHA-512 before continuing. Native/WASM CI runs only the backend proof cases in its second test pass; source formatting runs once.

Release jobs require `!cancelled()` as well as successful verification. Cancelling a workflow therefore also cancels publication work; completed registry writes remain immutable.
