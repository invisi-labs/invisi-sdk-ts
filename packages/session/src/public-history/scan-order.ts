import type { WalletState, WalletScope, WalletStore } from "../storage/state";
import { highestGap, type CoverageRange } from "./coverage";
import { PublicHistory, type AcquiredHistoryPage, type PublicSyncOptions } from "./history";
import type { PublicHistorySnapshot } from "./store";
export function accountCoverage(
    state: WalletState,
    deployment: bigint
): CoverageRange<import("../storage/state").Checkpoint>[] {
    return (
        state.discoveryRanges ??
        (state.discoveryThrough ? [{ fromBlock: deployment, block: state.discoveryThrough }] : [])
    );
}
export function firstScanRange(
    state: WalletState,
    history: PublicHistorySnapshot,
    deployment: bigint,
    lower: bigint,
    target: bigint,
    size: number,
    reset = false
): { fromBlock: bigint; toBlock: bigint; direction: "forward" | "backward" } | undefined {
    if (lower > target) return undefined;
    const ranges = reset ? [] : accountCoverage(state, deployment),
        highest = ranges.at(-1)?.block.number;
    if (highest !== undefined && highest >= target) {
        const gap = highestGap(ranges, lower, target);
        if (!gap) return undefined;
        return {
            fromBlock:
                gap.toBlock - BigInt(size) + 1n > gap.fromBlock
                    ? gap.toBlock - BigInt(size) + 1n
                    : gap.fromBlock,
            toBlock: gap.toBlock,
            direction: "backward",
        };
    }
    const cached = history.pages
        .filter((page) => page.fromBlock <= target && page.block.number >= lower)
        .at(-1);
    let from =
        highest !== undefined ? highest + 1n : (cached?.fromBlock ?? target - BigInt(size) + 1n);
    if (from < lower) from = lower;
    const end = from + BigInt(size) - 1n;
    return { fromBlock: from, toBlock: end < target ? end : target, direction: "forward" };
}
export async function* priorityPages(
    history: PublicHistory,
    store: WalletStore,
    scope: WalletScope,
    settings: {
        lower: bigint;
        target: bigint;
        size: number;
        reset?: boolean;
        offline?: boolean;
        signal?: AbortSignal;
        onProgress?: PublicSyncOptions["onProgress"];
    },
    staged?: AcquiredHistoryPage
) {
    const base = await store.readSnapshot(scope),
        snapshot = await history.snapshot();
    const initial = firstScanRange(
        base,
        snapshot,
        history.scope.deploymentBlock,
        settings.lower,
        settings.target,
        settings.size,
        !!settings.reset
    );
    const refill = settings.offline
        ? undefined
        : {
              pageSize: settings.size,
              ...(settings.signal ? { signal: settings.signal } : {}),
              ...(settings.onProgress ? { onProgress: settings.onProgress } : {}),
          };
    if (initial?.direction === "forward") {
        for await (const page of history.pages(initial.fromBlock, settings.target, refill, staged))
            yield { page, direction: "forward" as const };
        staged = undefined;
    }
    while (true) {
        settings.signal?.throwIfAborted();
        const state = await store.readSnapshot(scope),
            gap = highestGap(
                accountCoverage(state, history.scope.deploymentBlock),
                settings.lower,
                settings.target
            );
        if (!gap) break;
        for await (const page of history.pagesReverse(gap.fromBlock, gap.toBlock, refill, staged))
            yield { page, direction: "backward" as const };
        staged = undefined;
    }
}
