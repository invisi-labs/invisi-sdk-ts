import { poseidonHash, TREE_DEPTH } from "@invisi-labs/primitives";
import { expect, it, vi } from "vitest";
import { block, context, h, setup, status, wireBlock } from "./ProtocolRpcClient-fixtures";

// Synthetic deterministic RPC benchmark. Every indexed request costs 5 ms and every
// chain read costs 2 ms under a virtual clock; cryptographic CPU time is excluded.
// Run: pnpm --filter @invisi-labs/rpc test -- MembershipBatch.benchmark.test.ts
async function inventory(size: number) {
    let layer = Array.from({ length: size }, (_, i) => BigInt(i + 1));
    const paths = layer.map(() => [] as string[]);
    for (let level = 0; level < TREE_DEPTH; level++) {
        for (let leaf = 0; leaf < size; leaf++) {
            const index = leaf >> level;
            paths[leaf]!.push(h(layer[index ^ 1] ?? 0n));
        }
        const next: bigint[] = [];
        for (let index = 0; index < layer.length; index += 2)
            next.push(BigInt(await poseidonHash([layer[index]!, layer[index + 1] ?? 0n])));
        layer = next;
    }
    const anchor = { treeId: 1, leafCount: size, root: h(layer[0]!), block: wireBlock };
    return {
        inputs: paths.map((_, index) => ({
            treeId: 1n,
            leafIndex: index,
            commitment: h(index + 1),
        })),
        proofs: paths.map((siblings, index) => ({
            anchor,
            leafIndex: index,
            commitment: h(index + 1),
            siblings,
        })),
        anchor,
    };
}

it("benchmarks sequential membership reads against shared batch evidence", async () => {
    const rows: object[] = [];
    for (const size of [1, 8, 32, 128]) {
        const f = await inventory(size);
        const measure = async (batch: boolean) => {
            const connection = setup((method, params) =>
                method === "invisi_getStatus"
                    ? status()
                    : method === "invisi_getRoots"
                      ? [f.anchor]
                      : f.proofs[Number(params[1])]
            );
            const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
            const fetch = connection.fetchMock;
            const getBlock = connection.reader.getBlock;
            const known = connection.reader.isKnownRoot;
            // Keep the actual client and its validation logic; delay only boundary calls.
            const client = new (
                connection.client
                    .constructor as typeof import("./ProtocolRpcClient").ProtocolRpcClient
            )({
                url: "http://localhost:8080/v1/chains/31337",
                deployment: (await import("./ProtocolRpcClient-fixtures")).deployment,
                fetch: async (...args) => {
                    await sleep(5);
                    return fetch(...args);
                },
                reader: {
                    getBlock: async (number) => {
                        await sleep(2);
                        return getBlock(number);
                    },
                    isKnownRoot: async () => {
                        await sleep(2);
                        return known();
                    },
                },
            });
            vi.useFakeTimers();
            vi.setSystemTime(0);
            try {
                const task = batch
                    ? client.getMemberships(context, f.inputs, block)
                    : (async () => {
                          const results = [];
                          for (const input of f.inputs)
                              results.push(await client.getMembership(context, input, block));
                          return results;
                      })();
                await vi.runAllTimersAsync();
                const result = await task;
                expect(result.map((proof) => proof.leafIndex)).toEqual(
                    f.inputs.map((input) => input.leafIndex)
                );
                return {
                    indexedRequests: connection.requests.length,
                    chainReads: getBlock.mock.calls.length + known.mock.calls.length,
                    modeledElapsedMs: Date.now(),
                };
            } finally {
                vi.useRealTimers();
            }
        };
        const sequential = await measure(false);
        const batch = await measure(true);
        expect(sequential.indexedRequests).toBe(3 * size);
        expect(batch.indexedRequests).toBe(size + 2);
        expect(batch.modeledElapsedMs).toBeLessThanOrEqual(sequential.modeledElapsedMs);
        rows.push({ size, sequential, batch });
    }
    console.info(
        "Membership benchmark (virtual network latency, crypto CPU excluded):",
        JSON.stringify(rows)
    );
}, 30_000);
