# Wallet history and Credit replay performance

This change preserves public wallet APIs and the current package versions. It does not publish a release or change a server API.

## What changes

- Credit discovery already queues chronological replay only when a newly recovered owned Credit requires it. Foreign Credit events and repeated scans without new owned grants do not start replay. Regression coverage now explicitly checks this, including a historical parent recovered after a descendant and forward transitions with missing delivery ciphertext.
- During Credit replay, authenticated pages without any Credit event do not need a private inventory transaction. Their checkpoint is committed together with the next Credit-bearing page or the final page. Interruption repeats the empty gap; it cannot advance the cursor past an uncommitted transition. Pages with revocation or other Credit events are still processed.
- One account scan has one bounded capture of immutable, block-hash-bound spent observations, known-root results and revocation words. New nullifiers fetch only missing observations. This capture is discarded between invocations. Canonical block reads and latest code/deployment reads are never satisfied by this reuse. Code/version/registry reads remain live during scanning.
- `ProtocolRpcClient.getHistoryUpdates` optionally supplies both existing discovery streams under one validated deployment/indexed status. Each stream still validates its response, range and canonical anchor and performs a fresh final canonical check. Individual existing methods remain available.
- A public synchronization pins one validated indexed status while catching up and descending older pages. Its canonical and generation fences remain live; the next synchronization obtains a fresh status.
- `TrustedProvider.getBlocks` obtains original full headers through the existing JSON-RPC transport in groups of at most 20. Responses may arrive out of order; IDs, count, errors, deployment pins and complete header RLP hashes are validated. PublicHistory checks count, height and every parent link before committing. Other ChainReader implementations keep the bounded eight-request fallback. This saves HTTP round trips; it does not assume that the server executes JSON-RPC batches concurrently.

## Safety boundaries

Receipt success and transaction binding, full header hash/parent checks, canonical anchors, membership and known roots, consumption, revocation, private revision and public generation fences remain enabled. The uncached checks before committing and before submitting operations remain in place. The new state-read capture cannot cross a wallet scan boundary, block hash, deployment, token/owner/shard/word context or a reorganization. Existing authenticated immutable membership-path reuse retains its separate root/generation checks. No private detection keys or wallet ownership filters are sent to a server.

Empty replay checkpoint coalescing changes write frequency only for pages with no Credit events. It does not defer a Credit state transition or any operation signing/submission journal. Interrupted discovery still exposes only committed inventory with its existing completeness flags.

## Reproducible measurements

Baseline: commit `7dbbb88`. Optimized: the source changes accompanying this report. Measurements run on the same local machine, three runs per version, using the actual PublicHistory and WalletSession scan pipeline with the checked-in authenticated test fixtures. Public header transport and spent-state reads have a controlled 10 ms delay in the performance scenarios; empty replay has no injected latency. Times exclude fixture setup and public-history seeding. Public tests use deterministic in-memory storage and chain-shaped headers; this is not a production BSC or proof-generation benchmark.

| Scenario | Baseline median | Optimized median | Work reduction | Median speedup |
| --- | ---: | ---: | --- | ---: |
| Cold public history, 256 blocks, batch-capable reader | 378.19 ms | 180.95 ms | Header HTTP-shaped reads: 260 → 17 | 2.09× |
| Warm private scan, 64 already cached empty pages and one owned Note | 1192.87 ms | 528.90 ms | Spent requests: 64 → 1 | 2.26× |
| Credit replay through 64 empty pages | 584.22 ms | 85.40 ms | Private transactions: 65 → 2 | 6.84× |
| Warm public history, same 256 blocks | 65.21 ms | 64.31 ms | Six fresh canonical reads retained | Approximately unchanged |

The two private transactions in the empty replay case are the existing live state refresh and the final atomic replay checkpoint. The batched cold header count includes 13 groups for 256 headers plus four live anchor reads. A separate actual JSON-RPC transport regression verifies that 45 full headers use three HTTP requests of sizes 20, 20 and 5.

Raw elapsed samples in ms:

- Cold batch-capable history: baseline `[376.01, 380.63, 378.19]`; optimized `[182.50, 180.95, 180.58]`.
- Warm private scan: baseline `[1186.41, 1211.40, 1192.87]`; optimized `[531.93, 528.90, 528.51]`.
- Empty Credit replay: baseline `[571.07, 584.22, 593.45]`; optimized `[100.96, 85.40, 78.48]`.
- Warm batch-capable public cache: baseline `[63.80, 65.48, 65.21]`; optimized `[64.26, 66.67, 64.31]`.

The ordinary single-header fallback remains at 260 calls for this cold range; it does not acquire a new trust source or skip headers. With zero injected network latency, private inventory cloning and authenticated cache reads remain significant and timing noise can hide the saved calls. These results do not imply the same speedup for proving, broadcast acceptance or finality waiting in a complete collection command.

Run the checked-in scenarios:

```bash
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@invisi-labs/session
WALLET_PERF=1 pnpm --filter @invisi-labs/session exec vitest run \
  src/public-history/history.test.ts src/sync/WalletUpdater.test.ts \
  -t 'benchmarks cold|real multi-page account|coalesces empty Credit'
```

Run three times and compare medians. For a baseline comparison, apply the benchmark tests to the baseline revision without the production changes. The new request-count expectations intentionally fail against that baseline after printing measurements. Do not change production source in an active build or test process.

## Regression and verification coverage

- Full-header batch response ordering, duplicate/missing/unexpected IDs, partial errors, version/deployment mismatch, corrupt complete header hashes and missing/out-of-order/broken-parent history batches.
- Shared discovery status is scoped to one combined read; either stream's anchor mismatch and a reorg between acquisition and final checks fail the whole read. The combined result also rejects individually valid streams from different block hashes, parent hashes, heights or timestamps.
- New account scans freshly observe a spend even when the height is unchanged; changed block hashes and revocation word keys do not reuse observations.
- Missing-only spent responses must preserve count/type validation; failed and malformed results are not cached, and large responses remain complete when cache retention evicts old entries.
- Credit replay with absent delivery ciphertext, late historical parent recovery, repeated scans, unrelated grants, interrupted empty replay and restart. A replay-only scan with `refreshState: false` must still use the original live chain reader for the commit fence; a same-height fork cannot clear the pending replay marker or commit old-fork state.
- Existing session suites cover corrupted membership, consumed/revoked state, reorg/generation invalidation, preparation snapshot boundaries and retained operation reservations.

## Remaining costs

Dense history still performs fresh membership acquisition/status checks per output. Cache payload authentication and private inventory cloning still have costs proportional to retained state. The SDK does not add a server-side full-header range API or change server batch scheduling. Further optimization should benchmark these cases separately and retain the same independently verified data and live canonical fences.

## Validation results

The complete workspace build passes (11 tasks). Targeted protocol, RPC and session tests and TypeScript checks pass; the complete workspace test command passes (21 tasks; 1,475 passed tests, 35 skipped across the workspace, including existing opt-in/live tests). Package boundaries, public surface interoperability, English-only source checks and formatting pass.

The browser bundle size gate has a pre-existing failure: the unchanged baseline main checkout produces 1,072,923 eager bytes against the existing 1 MiB ceiling. This change produces 1,076,295 bytes (+3,372 bytes), with no added dependencies or proving resources. The threshold is not changed. This warning must be handled as a separate bundle-budget change rather than being reported as a passing browser gate.
