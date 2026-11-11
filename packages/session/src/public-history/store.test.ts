import { expect, it } from "vitest";
import { MemoryAtomicRecords } from "../storage/store";
import { PublicHistoryStore } from "./store";

const scope = {
    chainId: 97n,
    protocolAddress: `0x${"11".repeat(20)}` as const,
    runtimeCodeHash: `0x${"22".repeat(32)}` as const,
    deploymentBlock: 100n,
};
const block = (number: bigint) => ({
    number,
    hash: `0x${number.toString(16).padStart(64, "0")}` as const,
    parentHash: `0x${(number - 1n).toString(16).padStart(64, "0")}` as const,
    timestamp: number,
});
it("persists empty coverage across store instances and distinguishes eviction from completeness", async () => {
    const records = new MemoryAtomicRecords();
    const store = new PublicHistoryStore(records, { persistent: false });
    await store.append(
        scope,
        {
            fromBlock: 100n,
            block: block(101n),
            headers: [block(100n), block(101n)],
            receipts: [],
            logs: [],
            verifiedPositions: [],
        },
        1
    );
    const reopened = new PublicHistoryStore(records, { persistent: false });
    expect((await reopened.snapshot(scope)).through?.number).toBe(101n);
    expect((await reopened.pageAt(scope, 100n))?.receipts).toEqual([]);
    await reopened.pruneBefore(scope, 102n);
    expect((await reopened.snapshot(scope)).through?.number).toBe(101n);
    expect(await reopened.pageAt(scope, 100n)).toBeUndefined();
});
it("does not bridge missing ranges or share pages across deployments", async () => {
    const store = new PublicHistoryStore(new MemoryAtomicRecords(), { persistent: false });
    await store.append(
        scope,
        {
            fromBlock: 101n,
            block: block(101n),
            headers: [block(101n)],
            receipts: [],
            logs: [],
            verifiedPositions: [],
        },
        1
    );
    expect((await store.snapshot(scope)).through).toBeUndefined();
    expect(
        await store.pageAt({ ...scope, protocolAddress: `0x${"33".repeat(20)}` }, 101n)
    ).toBeUndefined();
    await store.append(
        scope,
        {
            fromBlock: 100n,
            block: block(100n),
            headers: [block(100n)],
            receipts: [],
            logs: [],
            verifiedPositions: [],
        },
        1
    );
    expect((await store.snapshot(scope)).through?.number).toBe(101n);
    await store.rewind(scope, 100n);
    expect((await store.snapshot(scope)).generation).toBe(2);
    expect(await store.pageAt(scope, 101n)).toBeUndefined();
});

it("detects corrupt pages and allows re-fetching the same immutable range", async () => {
    const records = new MemoryAtomicRecords();
    const store = new PublicHistoryStore(records, { persistent: false });
    const page = {
        fromBlock: 100n,
        block: block(100n),
        headers: [block(100n)],
        receipts: [],
        logs: [],
        verifiedPositions: [],
    };
    const state = await store.append(scope, page, 1);
    const reference = state.pages[0]!;
    const stored = (await records.read(reference.key))!;
    await records.compareAndSwap(reference.key, stored.revision, {
        revision: stored.revision + 1,
        data: new Uint8Array([0]),
    });
    await expect(store.read(reference)).rejects.toThrow(/corrupt/);
    await store.discard(scope, reference);
    await store.append(scope, page, 1);
    expect(await store.pageAt(scope, 100n)).toEqual(page);
});

it("automatically bounds retained pages and bytes without forgetting historical coverage", async () => {
    const store = new PublicHistoryStore(new MemoryAtomicRecords(), {
        persistent: false,
        retention: { maxPages: 2, maxBytes: 100_000, maxPageBytes: 50_000 },
    });
    for (let n = 100n; n < 106n; n++)
        await store.append(
            scope,
            {
                fromBlock: n,
                block: block(n),
                headers: [block(n)],
                receipts: [],
                logs: [],
                verifiedPositions: [],
            },
            1
        );
    const state = await store.snapshot(scope);
    expect(state.through?.number).toBe(105n);
    expect(state.pages).toHaveLength(2);
    expect(await store.pageAt(scope, 100n)).toBeUndefined();
    await store.append(
        scope,
        {
            fromBlock: 100n,
            block: block(100n),
            headers: [block(100n)],
            receipts: [],
            logs: [],
            verifiedPositions: [],
        },
        1
    );
    expect(await store.pageAt(scope, 100n)).toBeUndefined();
    expect((await store.snapshot(scope)).pages.map((p) => p.block.number)).toEqual([104n, 105n]);
});

it("keeps completed backward validation even when recent-only retention evicts old pages", async () => {
    const store = new PublicHistoryStore(new MemoryAtomicRecords(), {
        persistent: false,
        retention: { maxPages: 1, maxBytes: 100_000, maxPageBytes: 50_000 },
    });
    for (let n = 105n; n >= 100n; n--)
        await store.append(
            scope,
            {
                fromBlock: n,
                block: block(n),
                headers: [block(n)],
                receipts: [],
                logs: [],
                verifiedPositions: [],
            },
            1
        );
    expect((await store.snapshot(scope)).through?.number).toBe(105n);
    expect((await store.snapshot(scope)).pages.map((p) => p.block.number)).toEqual([105n]);
    const reopened = new PublicHistoryStore(store.records, { persistent: false });
    expect((await reopened.snapshot(scope)).through?.number).toBe(105n);
});
