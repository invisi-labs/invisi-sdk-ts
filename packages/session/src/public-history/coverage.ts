import type { CanonicalBlock } from "@invisi-labs/protocol";
import type { Checkpoint } from "../storage/state";
export interface CoverageRange<Block extends Checkpoint = CanonicalBlock> {
    fromBlock: bigint;
    block: Block;
}
/** Coverage describes completed validation, independently from cache retention. */
export function mergeCoverage<Block extends Checkpoint>(
    ranges: readonly CoverageRange<Block>[],
    input: CoverageRange<Block>
): CoverageRange<Block>[] {
    const sorted = structuredClone([...ranges, input]).sort((a, b) =>
        a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0
    );
    const merged: CoverageRange<Block>[] = [];
    for (const range of sorted) {
        if (
            typeof range.fromBlock !== "bigint" ||
            range.fromBlock < 0n ||
            typeof range.block.number !== "bigint" ||
            range.block.number < range.fromBlock ||
            !/^0x[0-9a-fA-F]{64}$/.test(range.block.hash)
        )
            throw Error("invalid history coverage");
        const previous = merged.at(-1);
        if (!previous || range.fromBlock > previous.block.number + 1n) {
            merged.push(range);
            continue;
        }
        if (
            range.block.number === previous.block.number &&
            range.block.hash !== previous.block.hash
        )
            throw Error("conflicting history coverage anchor");
        if (range.block.number > previous.block.number) previous.block = range.block;
    }
    if (merged.length > 4096) throw Error("history coverage too fragmented");
    return merged;
}
/** Return the closest missing interval to the requested head. */
export function highestGap<Block extends Checkpoint>(
    ranges: readonly CoverageRange<Block>[],
    from: bigint,
    to: bigint
): { fromBlock: bigint; toBlock: bigint } | undefined {
    if (to < from) return undefined;
    let cursor = to;
    for (const range of [...ranges].sort((a, b) =>
        a.fromBlock > b.fromBlock ? -1 : a.fromBlock < b.fromBlock ? 1 : 0
    )) {
        if (range.fromBlock > cursor) continue;
        if (range.block.number < cursor)
            return {
                fromBlock: range.block.number + 1n > from ? range.block.number + 1n : from,
                toBlock: cursor,
            };
        cursor = range.fromBlock - 1n;
        if (cursor < from) return undefined;
    }
    return cursor >= from ? { fromBlock: from, toBlock: cursor } : undefined;
}
