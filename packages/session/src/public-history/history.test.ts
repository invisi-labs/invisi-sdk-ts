import { expect, it, vi } from "vitest";
import type { ChainReader, ProtocolDataProvider } from "@invisi-labs/protocol";
import type { Protocol } from "@invisi-labs/rpc";
import { MemoryAtomicRecords } from "../storage/store";
import { PublicHistoryStore } from "./store";
import { PublicHistory } from "./history";

const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as const;
const block = (number: bigint) => ({
    number,
    hash: hex(number),
    parentHash: hex(number - 1n),
    timestamp: number,
});

function fixture(broken?: bigint) {
    let active = 0;
    let peak = 0;
    const reader = {
        getBlock: vi.fn(async (number: bigint) => {
            peak = Math.max(peak, ++active);
            try {
                await Promise.resolve();
                return {
                    ...block(number),
                    ...(number === broken ? { parentHash: hex(999n) } : {}),
                };
            } finally {
                active--;
            }
        }),
    } as unknown as ChainReader;
    const protocol = {
        context: { chainId: 97n, protocolAddress: `0x${"11".repeat(20)}` },
        deployment: { protocol: { fromBlock: 100n, runtimeCodeHash: hex(1n) } },
        validateDeployment: async () => {},
    } as unknown as Protocol;
    const protocolRpc = {
        getStatus: async () => ({ indexedHead: block(115n) }),
        getNoteUpdates: async () => ({ block: block(115n), notes: [] }),
        getCreditTransitions: async () => ({ block: block(115n), transitions: [] }),
    } as unknown as ProtocolDataProvider;
    const history = new PublicHistory({
        reader,
        protocol,
        protocolRpc,
        store: new PublicHistoryStore(new MemoryAtomicRecords(), { persistent: false }),
    });
    return { history, peak: () => peak };
}

it("reads page headers concurrently with a bounded request count and preserves their order", async () => {
    const { history, peak } = fixture();
    await history.synchronize({ fromBlock: 100n, toBlock: 115n });
    expect(peak()).toBeGreaterThan(1);
    expect(peak()).toBeLessThanOrEqual(8);
    const page = await history.options.store.pageAt(history.scope, 100n);
    expect(page?.headers.map((value) => value.number)).toEqual(
        Array.from({ length: 16 }, (_, index) => 100n + BigInt(index))
    );
});

it("rejects a broken parent link across concurrent batches without committing coverage", async () => {
    const { history } = fixture(108n);
    await expect(history.synchronize({ fromBlock: 100n, toBlock: 115n })).rejects.toThrow(
        "noncanonical public history headers"
    );
    expect((await history.snapshot()).coverage).toEqual([]);
    expect((await history.snapshot()).pages).toEqual([]);
});

it("pins one validated indexed status per synchronization while keeping fresh canonical fences", async () => {
    const { history } = fixture();
    const rpc = history.options.protocolRpc;
    const getStatus = vi.spyOn(rpc, "getStatus");
    rpc.getNoteUpdates = async (_context, range) => ({ block: block(range.toBlock), notes: [] });
    rpc.getCreditTransitions = async (_context, range) => ({
        block: block(range.toBlock),
        transitions: [],
    });
    await history.synchronize({ pageSize: 1 });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect((await history.snapshot()).coverage?.[0]?.block.number).toBe(115n);
    await history.synchronize({ pageSize: 1 });
    expect(getStatus).toHaveBeenCalledTimes(2);
});
it("uses optional batch headers and rejects partial or out-of-order results before committing", async () => {
    const { history } = fixture();
    const getBlocks = vi.fn(async (numbers: readonly bigint[]) => numbers.map(block));
    history.options.reader.getBlocks = getBlocks;
    await history.synchronize({ fromBlock: 100n, toBlock: 115n });
    expect(getBlocks).toHaveBeenCalledTimes(1);
    expect(getBlocks.mock.calls[0]![0]).toHaveLength(16);
    for (const bad of ["partial", "reordered", "broken-parent"] as const) {
        const f = fixture();
        f.history.options.reader.getBlocks = async (numbers) => {
            const blocks = numbers.map(block);
            if (bad === "partial") return blocks.slice(1);
            if (bad === "reordered") return blocks.reverse();
            blocks[8] = { ...blocks[8]!, parentHash: hex(999n) };
            return blocks;
        };
        await expect(f.history.synchronize({ fromBlock: 100n, toBlock: 115n })).rejects.toThrow(
            /public history headers/
        );
        expect((await f.history.snapshot()).coverage).toEqual([]);
    }
});

it.runIf(!!process.env.WALLET_PERF)(
    "benchmarks cold and warm full-header history acquisition",
    async () => {
        for (const batched of [false, true]) {
            let headerRequests = 0;
            const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
            const { history } = fixture();
            const reader = history.options.reader;
            reader.getBlock = async (n) => {
                headerRequests++;
                await pause();
                return block(n);
            };
            if (batched)
                reader.getBlocks = async (numbers) => {
                    headerRequests++;
                    await pause();
                    return numbers.map(block);
                };
            const rpc = history.options.protocolRpc;
            rpc.getStatus = async () => ({ indexedHead: block(355n) });
            rpc.getNoteUpdates = async (_context, range) => ({
                block: block(range.toBlock),
                notes: [],
            });
            rpc.getCreditTransitions = async (_context, range) => ({
                block: block(range.toBlock),
                transitions: [],
            });
            let started = performance.now();
            await history.synchronize({ fromBlock: 100n, toBlock: 355n, pageSize: 256 });
            console.log(
                JSON.stringify({
                    scenario: "cold-public-256",
                    batched,
                    elapsedMs: performance.now() - started,
                    headerRequests,
                    latencyMs: 10,
                })
            );
            headerRequests = 0;
            started = performance.now();
            await history.synchronize({ fromBlock: 100n, toBlock: 355n, pageSize: 256 });
            console.log(
                JSON.stringify({
                    scenario: "warm-public-256",
                    batched,
                    elapsedMs: performance.now() - started,
                    headerRequests,
                    latencyMs: 10,
                })
            );
            expect((await history.snapshot()).coverage?.[0]?.block.number).toBe(355n);
        }
    }
);
