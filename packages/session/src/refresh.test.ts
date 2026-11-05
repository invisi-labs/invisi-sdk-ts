import { expect, it, vi } from "vitest";
import type { ProtocolDataProvider } from "@invisi-labs/protocol";
import { refreshWallet } from "./refresh";

const hash = `0x${"01".repeat(32)}` as const;
const context = { chainId: 31337n, protocolAddress: `0x${"01".repeat(20)}` as const };
const block = (number: bigint) => ({ number, hash, parentHash: hash, timestamp: number });
function fixture() {
    const getStatus = vi.fn(async () => ({
        indexedHead: block(260n),
        detectionEnabled: true,
        checkedBits: 8,
    }));
    const getUpdates = vi.fn(
        async (...[_context, range]: Parameters<ProtocolDataProvider["getUpdates"]>) => ({
            block: block(range.toBlock),
            transactionHashes: [] as `0x${string}`[],
        })
    );
    const provider = { getStatus, getUpdates, getMembership: vi.fn() } as ProtocolDataProvider;
    const apply = vi.fn(
        async (
            batch: import("./WalletUpdater").CandidatePage,
            _options: import("./WalletUpdater").ApplyPageOptions
        ) => ({
            block: batch.block,
            notes: 1,
            credits: 2,
            balances: [],
        })
    );
    return {
        runtime: {
            context,
            fromBlock: 10n,
            provider,
            apply,
            reader: { getBlock: async (n: bigint) => block(n) },
        },
        getStatus,
        getUpdates,
        apply,
    };
}
it("pulls bounded indexed pages and resets private inventory only on the first page", async () => {
    const h = fixture();
    h.getUpdates.mockImplementation(async (_context, range) => ({
        block: block(range.toBlock),
        transactionHashes: [hash],
    }));
    const key = new Uint8Array(32).fill(1);
    const result = await refreshWallet(h.runtime, {
        fromBlock: 10n,
        pageSize: 100,
        detectionKey: key,
        reset: true,
    });
    expect(h.getUpdates.mock.calls.map(([, range]) => [range.fromBlock, range.toBlock])).toEqual([
        [10n, 109n],
        [110n, 209n],
        [210n, 260n],
    ]);
    expect(h.apply.mock.calls.map(([, options]) => options.reset)).toEqual([
        true,
        undefined,
        undefined,
    ]);
    expect(result).toMatchObject({ block: block(260n), notes: 3, credits: 6 });
    expect(h.apply.mock.calls.every(([batch]) => batch.block.number === 260n)).toBe(true);
    expect(key.every((n) => n === 0)).toBe(true);
});
it("does not delegate a detector implicitly and propagates caller cancellation", async () => {
    const h = fixture();
    const controller = new AbortController();
    await refreshWallet(h.runtime, { fromBlock: 10n, toBlock: 10n, signal: controller.signal });
    expect(h.getUpdates.mock.calls[0]![1]).not.toHaveProperty("detectionKey");
    expect(h.getUpdates.mock.calls[0]![1].signal).toBe(controller.signal);
    controller.abort();
    await expect(
        refreshWallet(h.runtime, { fromBlock: 11n, signal: controller.signal })
    ).rejects.toThrow();
    expect(h.getUpdates).toHaveBeenCalledTimes(1);
});
it("rejects invalid ranges and service page anchors without applying anything", async () => {
    const h = fixture();
    for (const settings of [
        { fromBlock: 9n },
        { fromBlock: 20n, toBlock: 19n },
        { fromBlock: 10n, toBlock: 261n },
        { fromBlock: 10n, pageSize: 10001 },
    ]) {
        await expect(refreshWallet(h.runtime, settings)).rejects.toThrow(/range|size|deployment/i);
    }
    h.getUpdates.mockImplementation(async () => ({ block: block(999n), transactionHashes: [] }));
    await expect(refreshWallet(h.runtime, { fromBlock: 10n, pageSize: 100 })).rejects.toThrow(
        /anchor/i
    );
    expect(h.apply).not.toHaveBeenCalled();
});
it("stops on a failed page instead of skipping it", async () => {
    const h = fixture();
    h.getUpdates.mockRejectedValueOnce(new Error("unavailable"));
    await expect(refreshWallet(h.runtime, { fromBlock: 10n })).rejects.toThrow("unavailable");
    expect(h.getUpdates).toHaveBeenCalledTimes(1);
    expect(h.apply).not.toHaveBeenCalled();
});

it("coalesces empty pages into one final state refresh", async () => {
    const h = fixture();
    h.apply.mockImplementation(async (batch) => ({
        block: batch.block,
        notes: 0,
        credits: 0,
        balances: [],
    }));
    const result = await refreshWallet(h.runtime, { fromBlock: 10n, pageSize: 100, reset: true });
    expect(h.getUpdates).toHaveBeenCalledTimes(3);
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply).toHaveBeenCalledWith(
        { context, block: block(260n), transactionHashes: [] },
        { reset: true }
    );
    expect(result).toMatchObject({ notes: 0, credits: 0 });
});
it("skips empty leading and trailing pages and delays reset until actual application", async () => {
    const h = fixture();
    h.getUpdates.mockImplementation(async (_context, range) => ({
        block: block(range.toBlock),
        transactionHashes: range.fromBlock === 110n ? [hash] : [],
    }));
    await refreshWallet(h.runtime, { fromBlock: 10n, pageSize: 100, reset: true });
    expect(h.apply).toHaveBeenCalledTimes(1);
    expect(h.apply.mock.calls[0]![0].transactionHashes).toEqual([hash]);
    expect(h.apply.mock.calls[0]![1].reset).toBe(true);
});
it("still validates skipped empty page anchors", async () => {
    const h = fixture();
    h.getUpdates.mockImplementation(async (_context, range) => ({
        block: block(range.fromBlock === 210n ? 999n : range.toBlock),
        transactionHashes: range.fromBlock === 10n ? [hash] : [],
    }));
    await expect(refreshWallet(h.runtime, { fromBlock: 10n, pageSize: 100 })).rejects.toThrow(
        /anchor/
    );
    expect(h.apply).toHaveBeenCalledTimes(1);
});

it("defaults to 10000 blocks and accepts an explicit 10000 block page", async () => {
    for (const pageSize of [undefined, 10000]) {
        const h = fixture();
        h.getStatus.mockResolvedValue({
            indexedHead: block(10010n),
            detectionEnabled: true,
            checkedBits: 8,
        });
        await refreshWallet(h.runtime, {
            fromBlock: 10n,
            ...(pageSize === undefined ? {} : { pageSize }),
        });
        expect(
            h.getUpdates.mock.calls.map(([, range]) => [range.fromBlock, range.toBlock])
        ).toEqual([
            [10n, 10009n],
            [10010n, 10010n],
        ]);
    }
});
