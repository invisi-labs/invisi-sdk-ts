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
