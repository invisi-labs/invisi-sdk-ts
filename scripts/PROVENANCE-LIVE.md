# Three-SDK live service checks

Run only against an explicitly owned local harness:

```sh
INVISI_PROVENANCE_LIVE=1 \
INVISI_PROVENANCE_TRUST=/path/to/owned-run/sdk-trust.json \
node scripts/provenance-live-all.mjs
```

The wrapper runs TS `live.test.ts`, Go `TestProvenanceLiveService` and Rust `provenance_live`. It creates no mock, proof or transaction and changes no App or wallet flow. Both the opt-in flag and trust file are mandatory. Disabled tests make no HTTP requests and are not live evidence.

The owned harness supplies public configuration: `format: invisi-provenance-sdk-live-v1`, endpoint, scope, generation, provider, initial/current key IDs and public keys, pinned manifest, verified rotation records, checkedAt, rootId, a public commitment and actual verified jobId. Tests pin the reviewed manifest and authenticate rotations from the externally pinned genesis key; service-returned public keys alone never establish trust. No wallet fixture or opening is read.

Checks cover real machine API metadata, root pagination, signed certificates, leaf replay at depth32, local membership, explicitly permitted remote membership comparison, Note recognition and native proof job identity. Incorrect provider/scope/generation/key/manifest trust must fail. No private material is sent.

Keep chain/service generation stable until all SDKs finish. Finish browser tests before shared rate-limit windows. `INVISI_PROVENANCE_LIVE_HOOK` runs this wrapper after the harness writes its trust file. Rate limits are failures, never successful protocol evidence.

The wrapper writes `sdk-live-validation.json` beside the trust file and sets `complete:true` only when every real test exits0. Retain it with the chain/proof/service reports. It contains public locators and results, no keys/nonces/witness. Default skipped live tests are not evidence.
