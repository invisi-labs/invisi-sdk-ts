import type { CanonicalBlock } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { WalletState } from "../storage/state";
import type { PublicHistoryScope, PublicHistorySnapshot } from "../public-history/store";
import { accountCoverage, firstScanRange } from "../public-history/scan-order";
export function missingRanges(
    ranges: ReturnType<typeof accountCoverage>,
    from: bigint,
    to: bigint
): { fromBlock: bigint; toBlock: bigint }[] {
    const gaps: { fromBlock: bigint; toBlock: bigint }[] = [];
    let next = from;
    for (const range of ranges) {
        if (range.block.number < next) continue;
        if (range.fromBlock > to) break;
        if (range.fromBlock > next)
            gaps.push({
                fromBlock: next,
                toBlock: range.fromBlock - 1n < to ? range.fromBlock - 1n : to,
            });
        if (range.block.number >= next) next = range.block.number + 1n;
    }
    if (next <= to) gaps.push({ fromBlock: next, toBlock: to });
    return gaps;
}
function blockProgress(ranges: ReturnType<typeof accountCoverage>, from: bigint, to: bigint) {
    const totalBlocks = to >= from ? to - from + 1n : 0n;
    let scannedBlocks = 0n;
    for (const range of ranges) {
        const start = range.fromBlock > from ? range.fromBlock : from,
            end = range.block.number < to ? range.block.number : to;
        if (end >= start) scannedBlocks += end - start + 1n;
    }
    return {
        fromBlock: from,
        toBlock: to,
        totalBlocks,
        scannedBlocks,
        complete: scannedBlocks === totalBlocks,
        ratio: totalBlocks === 0n ? null : Number((scannedBlocks * 10_000n) / totalBlocks) / 10_000,
        unit: "blocks" as const,
    };
}
export function scanStatus(
    state: WalletState,
    history: PublicHistorySnapshot,
    scope: PublicHistoryScope
) {
    const ranges = state.invalidated ? [] : accountCoverage(state, scope.deploymentBlock),
        indexed = history.indexedHead ?? history.coverage?.at(-1)?.block ?? history.through;
    const knownHead = history.knownHead ?? indexed;
    const chainHeight = knownHead?.number ?? null,
        indexedHeight = indexed?.number ?? null,
        maxScanned = ranges.at(-1)?.block;
    const unresolvedCount =
        state.unresolvedDeliveryCount ?? Object.keys(state.unresolvedDeliveries ?? {}).length;
    const fully = state.invalidated ? null : (state.discoveryThrough ?? null);
    const scanComplete =
        !state.invalidated &&
        knownHead !== undefined &&
        fully?.number === knownHead.number &&
        fully.hash === knownHead.hash;
    const isSynced = scanComplete && state.creditReplayFrom === undefined;
    const boundary =
        state.recoveryBoundary ??
        (indexedHeight === null
            ? scope.deploymentBlock
            : (firstScanRange(
                  state,
                  history,
                  scope.deploymentBlock,
                  scope.deploymentBlock,
                  indexedHeight,
                  100
              )?.fromBlock ?? (fully ? fully.number + 1n : scope.deploymentBlock)));
    const gaps =
        chainHeight === null ? [] : missingRanges(ranges, scope.deploymentBlock, chainHeight);
    const first =
        indexedHeight === null
            ? undefined
            : firstScanRange(
                  state,
                  history,
                  scope.deploymentBlock,
                  scope.deploymentBlock,
                  indexedHeight,
                  100
              );
    const suggestions: { fromBlock: bigint; toBlock: bigint; direction: "forward" | "backward" }[] =
        [];
    if (first?.direction === "forward")
        suggestions.push({
            fromBlock: first.fromBlock,
            toBlock: indexedHeight!,
            direction: "forward",
        });
    const olderTo = first?.direction === "forward" ? first.fromBlock - 1n : indexedHeight;
    if (olderTo !== null)
        for (const gap of missingRanges(ranges, scope.deploymentBlock, olderTo).reverse())
            suggestions.push({ ...gap, direction: "backward" });
    const nextAction = state.invalidated
        ? "rebuild"
        : indexedHeight === null
          ? "discover-head"
          : indexedHeight !== null &&
              (maxScanned?.number ?? scope.deploymentBlock - 1n) < indexedHeight
            ? "update-head"
            : suggestions.length
              ? "recover-history"
              : state.creditReplayFrom !== undefined
                ? "recover-credit"
                : unresolvedCount
                  ? "retry-unresolved"
                  : !isSynced
                    ? "wait-for-indexer"
                    : "none";
    return {
        publicThrough: history.through ?? null,
        accountThrough: fully,
        unresolvedCount,
        assetCompleteness:
            isSynced && !unresolvedCount ? ("complete" as const) : ("unknown" as const),
        invalidated: !!state.invalidated,
        recoveryStartHeight: scope.deploymentBlock,
        recoveryBoundary: boundary,
        chainHeight,
        indexedHeight,
        maxScannedHeight: maxScanned?.number ?? null,
        fullyScannedHeight: fully?.number ?? null,
        scanComplete,
        isSynced,
        unscannedRanges: gaps,
        suggestedScanRanges: suggestions,
        nextAction,
        creditRecoveryPending: state.creditReplayFrom !== undefined,
        progress:
            chainHeight === null
                ? null
                : {
                      recent: blockProgress(ranges, boundary, chainHeight),
                      recovery: blockProgress(ranges, scope.deploymentBlock, boundary - 1n),
                      overall: blockProgress(ranges, scope.deploymentBlock, chainHeight),
                  },
    };
}
/** Eligibility of known inputs, independent of whether historical discovery is complete. */
export function fundsStatus(
    state: WalletState,
    token: Hex,
    head?: import("../storage/state").Checkpoint
) {
    let spendableKnown = 0n,
        reservedKnown = 0n;
    let checkedThrough: import("../storage/state").Checkpoint | null = null;
    for (const [id, record] of Object.entries(state.notes)) {
        if (record.note.tokenAddress !== BigInt(token)) continue;
        if (state.reservations[id] && record.spent !== "spent") reservedKnown += record.note.amount;
        if (record.spent !== "unspent" || !record.checkedThrough || state.reservations[id])
            continue;
        if (
            head &&
            (record.checkedThrough.number !== head.number ||
                record.checkedThrough.hash !== head.hash)
        )
            continue;
        if (state.invalidated) continue;
        spendableKnown += record.note.amount;
        if (!checkedThrough || record.checkedThrough.number < checkedThrough.number)
            checkedThrough = { ...record.checkedThrough };
    }
    return {
        tokenAddress: token,
        spendableKnown,
        reservedKnown,
        checkedThrough,
        areFundsSpendable: !state.invalidated && spendableKnown > 0n,
        requiresPreparationValidation: true as const,
        invalidated: !!state.invalidated,
    };
}

export type WalletScanStatus = ReturnType<typeof scanStatus>;
export type WalletFundsStatus = ReturnType<typeof fundsStatus>;
