import { poseidonHash, TREE_DEPTH } from "@invisi-labs/primitives";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ProtocolRpcClient, ProtocolRpcError } from "./ProtocolRpcClient";
import { block, context, h, setup, status, wireBlock } from "./ProtocolRpcClient-fixtures";

describe("ProtocolRpcClient", () => {
    it("accepts a service URL and preserves deployment pins when binding a reader", async () => {
        expect(() => new ProtocolRpcClient("http://localhost:8080/v1")).not.toThrow();
        expect(() => new ProtocolRpcClient("file:///tmp/rpc")).toThrow();
        const { client, reader } = setup(() => status());
        const verified = client.withReader(reader);
        expect(verified).not.toBe(client);
        expect((await verified.getStatus(context)).indexedHead).toEqual(block);
    });

    it("redacts configuration from JSON and inspection", () => {
        const { client } = setup(() => status(), {
            token: "private-api-token",
            url: "https://rpc.example/v1/chains/31337?secret=private-url-value",
        });
        for (const serialized of [
            JSON.stringify(client),
            inspect(client),
            inspect(client, { showHidden: true }),
            JSON.stringify({ ...client }),
        ]) {
            expect(serialized).not.toMatch(
                /private-api-token|private-url-value|rpc.example|reader|options|deployment|fetch/
            );
        }
        expect(client.toJSON()).toEqual({ type: "ProtocolRpcClient", redacted: true });
    });

    it("accepts API v1 and Protocol version 1 decimal pins and enriches the indexed head independently", async () => {
        const { client } = setup(() => status());
        expect((await client.getStatus(context)).indexedHead).toEqual(block);
    });
    it.each([
        { apiVersion: "unsupported" },
        { protocolVersion: "2" },
        {
            deployment: {
                ...status().deployment,
                protocol: { ...status().deployment.protocol, runtimeCodeHash: h(8) },
            },
        },
        { indexedHead: { ...wireBlock, hash: h(3) } },
    ])("rejects untrusted status metadata %j", async (patch) => {
        const { client } = setup(() => ({ ...status(), ...patch }));
        await expect(client.getStatus(context)).rejects.toBeInstanceOf(ProtocolRpcError);
    });
    it("handles nil ordinary Note arrays on its own route", async () => {
        const { client, requests } = setup((method) =>
            method === "invisi_getStatus" ? status() : { blockHash: h(10), notes: null }
        );
        expect(
            (await client.getNoteUpdates(context, { fromBlock: 1n, toBlock: 10n })).notes
        ).toEqual([]);
        expect(requests[1]).toMatchObject({
            method: "invisi_getNoteUpdates",
            params: [{ fromBlock: 1, toBlock: 10, blockHash: h(10) }],
        });
    });
    it("rejects invalid range, update anchor and malformed refs", async () => {
        const { client } = setup((m) =>
            m === "invisi_getStatus"
                ? status()
                : { blockHash: h(9), notes: null, creditTransitions: null }
        );
        await expect(
            client.getNoteUpdates(context, { fromBlock: 1n, toBlock: 10001n })
        ).rejects.toThrow(/100/);
        await expect(
            client.getNoteUpdates(context, { fromBlock: 1n, toBlock: 10n })
        ).rejects.toThrow(/anchor/);
    });
    it("verifies membership root, path and earlier canonical anchor", async () => {
        const siblings = Array(TREE_DEPTH).fill(h(0));
        let root = 1n;
        for (let i = 0; i < TREE_DEPTH; i++) root = BigInt(await poseidonHash([root, 0n]));
        const proof = {
            anchor: {
                treeId: 1,
                leafCount: 1,
                root: h(root),
                block: { number: 9, hash: h(9), parentHash: h(8), timestamp: 123 },
            },
            leafIndex: 0,
            commitment: h(1),
            siblings,
        };
        const selected = structuredClone(proof.anchor);
        const serviceRoots = [selected];
        const { client, reader, requests } = setup((m) =>
            m === "invisi_getStatus"
                ? { ...status(), indexedHead: selected.block }
                : m === "invisi_getRoots"
                  ? serviceRoots
                  : proof
        );
        expect(
            (
                await client.getMembership(
                    context,
                    { treeId: 1n, leafIndex: 0, commitment: h(1) },
                    block
                )
            ).block
        ).toEqual(block);
        expect(requests.find((r) => r.method === "invisi_getMembership")!.params[2]).toBe(h(root));
        expect(reader.isKnownRoot).toHaveBeenCalledWith(context, 1n, h(root), block);
        serviceRoots.push({ ...selected, root: h(77), block: wireBlock });
        const pinnedInput = { treeId: 1n, leafIndex: 0, commitment: h(1), root: h(root) };
        expect((await client.getMembership(context, pinnedInput, block)).root).toBe(h(root));
        await expect(
            client.getMembership(context, { ...pinnedInput, root: h(88) }, block)
        ).rejects.toThrow(/known.*root/i);
        serviceRoots.pop();

        vi.mocked(reader.isKnownRoot).mockResolvedValue(false);
        await expect(
            client.getMembership(context, { treeId: 1n, leafIndex: 0, commitment: h(1) }, block)
        ).rejects.toThrow(/known.*root/i);
        vi.mocked(reader.isKnownRoot).mockResolvedValue(true);
        for (const patch of [
            { commitment: h(2) },
            { leafIndex: 1 },
            { siblings: [h(0)] },
            { anchor: { ...proof.anchor, root: h(3) } },
            { anchor: { ...proof.anchor, leafCount: 0 } },
            { anchor: { ...proof.anchor, treeId: 2 } },
            {
                anchor: {
                    ...proof.anchor,
                    block: { number: 11, hash: h(11), parentHash: h(10), timestamp: 123 },
                },
            },
            {
                anchor: {
                    ...proof.anchor,
                    block: { number: 9, hash: h(8), parentHash: h(8), timestamp: 123 },
                },
            },
            { siblings: [h(2), ...siblings.slice(1)] },
            { siblings: [h(2n ** 256n - 1n), ...siblings.slice(1)] },
        ]) {
            Object.assign(proof, patch);
            await expect(
                client.getMembership(context, { treeId: 1n, leafIndex: 0, commitment: h(1) }, block)
            ).rejects.toBeInstanceOf(ProtocolRpcError);
            Object.assign(proof, {
                commitment: h(1),
                leafIndex: 0,
                siblings,
                anchor: {
                    treeId: 1,
                    leafCount: 1,
                    root: h(root),
                    block: { number: 9, hash: h(9), parentHash: h(8), timestamp: 123 },
                },
            });
        }
    });
    it.each([
        null,
        [],
        [
            {
                treeId: 1,
                leafCount: 1,
                root: h(2),
                block: { number: 11, hash: h(11), parentHash: h(10), timestamp: 123 },
            },
        ],
    ])("rejects missing or future indexed roots", async (roots) => {
        const { client, requests } = setup((m) => (m === "invisi_getStatus" ? status() : roots));
        await expect(
            client.getMembership(context, { treeId: 1n, leafIndex: 0, commitment: h(1) }, block)
        ).rejects.toThrow(/known.*root/i);
        expect(requests.some((r) => r.method === "invisi_getMembership")).toBe(false);
    });
    it("rejects pre-abort without sending a request", async () => {
        const { client, fetchMock } = setup(() => status());
        const controller = new AbortController();
        controller.abort();
        await expect(
            client.getStatus(context, { signal: controller.signal })
        ).rejects.toMatchObject({ kind: "aborted" });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it("reports transport and timeouts without leaking upstream material", async () => {
        const transport = setup(() => status(), {
            fetch: async () => {
                throw new Error("secret");
            },
        });
        await expect(transport.client.getStatus(context)).rejects.toMatchObject({
            kind: "transport",
            message: "RPC transport or JSON decoding failed",
        });
        const timeout = setup(() => status(), {
            timeoutMs: 5,
            fetch: async (_url: string, init: RequestInit) =>
                new Promise((_resolve, reject) =>
                    init.signal!.addEventListener("abort", () => reject(new Error("secret")))
                ),
        });
        await expect(timeout.client.getStatus(context)).rejects.toMatchObject({ kind: "timeout" });
    });
    it.each([
        { jsonrpc: "1.0", id: 1, result: null },
        { jsonrpc: "2.0", id: 99, result: null },
        { jsonrpc: "2.0", id: 1, error: { code: -1, message: "secret" } },
    ])("validates response envelope and RPC errors", async (body) => {
        const { client } = setup(() => status(), {
            fetch: async () => new Response(JSON.stringify(body)),
        });
        await expect(client.getStatus(context)).rejects.toBeInstanceOf(ProtocolRpcError);
        await expect(client.getStatus(context)).rejects.not.toThrow(/secret/);
    });
});

it.each([undefined, -1, 124])(
    "rejects missing, invalid or forged RPC block timestamp %s",
    async (timestamp) => {
        const { client } = setup(() => ({ ...status(), indexedHead: { ...wireBlock, timestamp } }));
        await expect(client.getStatus(context)).rejects.toThrow();
    }
);

it("authenticates event block timestamps before accepting update candidates", async () => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  notes: [
                      {
                          transactionHash: h(2),
                          logIndex: 0,
                          block: { ...wireBlock, timestamp: 124 },
                      },
                  ],
                  creditTransitions: [],
              }
    );
    await expect(client.getNoteUpdates(context, { fromBlock: 1n, toBlock: 10n })).rejects.toThrow(
        "canonical block mismatch"
    );
});

it("accepts exactly 10000 update blocks and reads only the requested canonical endpoint", async () => {
    const { client, reader } = setup((method) =>
        method === "invisi_getStatus"
            ? {
                  ...status(),
                  indexedHead: {
                      ...wireBlock,
                      number: 20000,
                      hash: h(20000),
                      parentHash: h(19999),
                  },
              }
            : { blockHash: h(10000), notes: null, creditTransitions: null }
    );
    await expect(
        client.getNoteUpdates(context, { fromBlock: 1n, toBlock: 10000n })
    ).resolves.toMatchObject({ block: { number: 10000n } });
    expect(reader.getBlock.mock.calls.map(([number]) => number)).toEqual([10000n, 10000n]);
});

it.each([null, { ...wireBlock, number: 9 }])(
    "rejects update ranges outside indexed history %j",
    async (indexedHead) => {
        const { client, reader, requests } = setup(() => ({ ...status(), indexedHead }));
        await expect(
            client.getNoteUpdates(context, { fromBlock: 1n, toBlock: 10n })
        ).rejects.toThrow(/indexed/);
        expect(reader.getBlock).not.toHaveBeenCalled();
        expect(requests).toHaveLength(1);
    }
);

it("accepts public-only status without detection metadata", async () => {
    const { client } = setup(() => status());
    expect(await client.getStatus(context)).toEqual({ indexedHead: block });
});
