# Merge managed TS submission network completion

The user authorized removing the extra chain-ID read while preserving the post-persistence final network fence and exact recovery. Existing isolated worktree and all prior changes stay in place; no commits/pushes/rebases.

Approach: reuse the already captured, observed post-persistence authority only for the stock self-contained managed Shield. Keep entry real chain ID, perform synchronous scope/authority identity checks after deployment validation, then perform the real terminal chain-ID read after persistence. Manual exports, direct standalone validation and custom/unobserved policies retain their original complete checks. The post-store wallet write observer, durable attempt/reservations and exact replay/status remain unchanged. No generic skip-network boolean and no persistent chain cache.

1. Freeze the eight-request baseline and reproduce three chain IDs around the actual durable commit.
2. Add a failing managed submission budget/order regression, plus blocked-commit network switch and recovery controls.
3. Add a synchronous scope assertion and explicitly bind deferred completion to the captured runtime/chain authority; integrate only the managed first-send caller.
4. Run focused tests and independent review, then the full TS tests/build/types/boundary checks.
5. Run identical default-nonce three-fixture/two-operation HTTP drivers sequentially before/after at 20ms; record raw requests/parameters, stage timing, source/driver hashes and limitations.

Review focus: no bypass on manual/custom paths, changes during deployment or store waits still reject, final RPC remains after commit, native store mutations during that RPC reject, failed persistence never sends, final guard failures retain the exact packet, unknown replay/known status adds no new chain checks.
