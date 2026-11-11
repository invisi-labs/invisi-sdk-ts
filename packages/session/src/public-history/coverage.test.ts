import { expect, it } from "vitest";
import { mergeCoverage, highestGap } from "./coverage";
const b = (number: bigint) => ({
    number,
    hash: `0x${number.toString(16).padStart(64, "0")}` as const,
});
it("merges backward coverage without claiming a missing prefix", () => {
    let ranges = mergeCoverage([], { fromBlock: 200n, block: b(299n) });
    expect(highestGap(ranges, 100n, 299n)).toEqual({ fromBlock: 100n, toBlock: 199n });
    ranges = mergeCoverage(ranges, { fromBlock: 100n, block: b(199n) });
    expect(ranges).toEqual([{ fromBlock: 100n, block: b(299n) }]);
    expect(highestGap(ranges, 100n, 299n)).toBeUndefined();
});
it("fills nearer gaps before the oldest gap and rejects incompatible anchors", () => {
    const ranges = mergeCoverage([{ fromBlock: 200n, block: b(299n) }], {
        fromBlock: 400n,
        block: b(499n),
    });
    expect(highestGap(ranges, 100n, 599n)).toEqual({ fromBlock: 500n, toBlock: 599n });
    expect(highestGap(ranges, 100n, 499n)).toEqual({ fromBlock: 300n, toBlock: 399n });
    expect(() =>
        mergeCoverage(ranges, {
            fromBlock: 250n,
            block: { ...b(299n), hash: `0x${"ff".repeat(32)}` },
        })
    ).toThrow(/anchor/);
});

it("returns no work for an empty refresh-only interval", () => {
    expect(highestGap([{ fromBlock: 100n, block: b(200n) }], 202n, 201n)).toBeUndefined();
});
