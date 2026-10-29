import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { poseidonHash, TREE_DEPTH } from "@invisi-labs/core";
import type { ProtocolDeployment } from "./deployment";
import type { Hex } from "@invisi-labs/core";
import { ProtocolRpcClient, ProtocolRpcError, type ProtocolRpcReader } from "./ProtocolRpcClient";
const h = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
const deployment: ProtocolDeployment = {
    chainId: 31337n,
    protocol: {
        address: "0x1111111111111111111111111111111111111111",
        runtimeCodeHash: h(9),
        fromBlock: 1n,
    },
};
const context = { chainId: deployment.chainId, protocolAddress: deployment.protocol.address };
const block = { number: 10n, hash: h(10), parentHash: h(9), timestamp: 123n };
const wireBlock = { number: 10, hash: h(10), parentHash: h(9) };
const status = () => ({
    apiVersion: "v1",
    protocolVersion: "1",
    deployment: {
        chainId: "31337",
        protocol: { address: deployment.protocol.address, runtimeCodeHash: h(9), fromBlock: 1 },
    },
    indexedHead: wireBlock,
    checkedBits: 8,
    detectionEnabled: true,
});
function setup(
    respond: (method: string, params: unknown[]) => unknown,
    options: Record<string, unknown> = {}
) {
    const requests: { method: string; params: unknown[] }[] = [];
    const fetchMock = vi.fn(async (_url, init) => {
        const request = JSON.parse(init!.body as string);
        requests.push(request);
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: request.id,
                result: respond(request.method, request.params),
            })
        );
    }) as unknown as typeof fetch;
    const reader = {
        getBlock: vi.fn(async (n: bigint) =>
            n === 10n ? block : { ...block, number: n, hash: h(n), parentHash: h(n - 1n) }
        ),
        isKnownRoot: vi.fn(async (): Promise<boolean> => true),
    } satisfies ProtocolRpcReader;
    return {
        client: new ProtocolRpcClient({
            url: "http://localhost:8080/v1/chains/31337",
            deployment,
            reader,
            fetch: fetchMock,
            ...options,
        }),
        reader,
        requests,
        fetchMock,
    };
}
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
        { apiVersion: "v2" },
        { protocolVersion: "2" },
        {
            deployment: {
                ...status().deployment,
                protocol: { ...status().deployment.protocol, runtimeCodeHash: h(8) },
            },
        },
        { indexedHead: { ...wireBlock, hash: h(3) } },
        { checkedBits: 25 },
    ])("rejects untrusted status metadata %j", async (patch) => {
        const { client } = setup(() => ({ ...status(), ...patch }));
        await expect(client.getStatus(context)).rejects.toBeInstanceOf(ProtocolRpcError);
    });
    it("handles nil output arrays and deduplicates every credit transition", async () => {
        const { client, requests } = setup((method) =>
            method === "invisi_getStatus"
                ? status()
                : {
                      blockHash: h(10),
                      outputs: null,
                      creditTransitions: [
                          { transactionHash: h(2), logIndex: 0 },
                          { transactionHash: h(2), logIndex: 1 },
                          { transactionHash: h(3), logIndex: 2 },
                      ],
                  }
        );
        expect(
            (await client.getUpdates(context, { fromBlock: 1n, toBlock: 10n })).transactionHashes
        ).toEqual([h(2), h(3)]);
        expect(requests[1]).toMatchObject({
            method: "invisi_getUpdates",
            params: [{ fromBlock: 1, toBlock: 10, blockHash: h(10) }],
        });
        expect(JSON.stringify(requests)).not.toMatch(/viewKey|spendKey|sign/);
    });
    it("delegates detection only for explicit valid keys and retains credit refs", async () => {
        const key = new Uint8Array(32);
        key[0] = 1;
        const { client, requests } = setup((method) =>
            method === "invisi_getStatus"
                ? status()
                : {
                      blockHash: h(10),
                      checkedBits: 8,
                      candidates: [
                          { output: { transactionHash: h(2), logIndex: 0 }, fallback: true },
                      ],
                      creditTransitions: [{ transactionHash: h(3), logIndex: 1 }],
                  }
        );
        expect(
            (await client.getUpdates(context, { fromBlock: 1n, toBlock: 10n, detectionKey: key }))
                .transactionHashes
        ).toEqual([h(2), h(3)]);
        expect(requests[1]!.method).toBe("invisi_detectOutputs");
        expect(requests[1]!.params[1]).toBe("0x01" + "00".repeat(31));
    });
    it("rejects invalid range, update anchor and malformed refs", async () => {
        const { client } = setup((m) =>
            m === "invisi_getStatus"
                ? status()
                : { blockHash: h(9), outputs: null, creditTransitions: null }
        );
        await expect(client.getUpdates(context, { fromBlock: 1n, toBlock: 101n })).rejects.toThrow(
            /100/
        );
        await expect(client.getUpdates(context, { fromBlock: 1n, toBlock: 10n })).rejects.toThrow(
            /anchor/
        );
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
                block: { number: 9, hash: h(9), parentHash: h(8) },
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
            { anchor: { ...proof.anchor, block: { number: 11, hash: h(11), parentHash: h(10) } } },
            { anchor: { ...proof.anchor, block: { number: 9, hash: h(8), parentHash: h(8) } } },
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
                    block: { number: 9, hash: h(9), parentHash: h(8) },
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
                block: { number: 11, hash: h(11), parentHash: h(10) },
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

describe("RPC deployment discovery", () => {
    const wire = () => ({
        apiVersion: "v1",
        protocolVersion: "1",
        deployment: {
            ...status().deployment,

            registry: {
                address: "0x2222222222222222222222222222222222222222",
                runtimeCodeHash: h(7),
                fromBlock: 0,
            },
        },
    });
    it("loads frozen deployment and registry pins before indexed queries", async () => {
        const { client, requests, reader } = setup(
            (method) => (method === "invisi_getDeployment" ? wire() : status()),
            { deployment: undefined }
        );
        await expect(client.getStatus(context)).rejects.toThrow(/Load the RPC deployment/);
        expect(requests).toHaveLength(0);
        const result = await client.getDeployment(31337n);
        expect(result.chainId).toBe(31337n);
        expect(result.registry?.fromBlock).toBe(0n);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.isFrozen(result.registry)).toBe(true);
        expect(reader.getBlock).not.toHaveBeenCalled();
        expect((await client.getStatus(context)).indexedHead).toEqual(block);
    });
    it.each([
        { apiVersion: "v2" },
        { protocolVersion: "2" },
        { deployment: { ...wire().deployment, chainId: "1" } },
        {
            deployment: {
                ...wire().deployment,
                protocol: { ...wire().deployment.protocol, runtimeCodeHash: h(0) },
            },
        },
        {
            deployment: {
                ...wire().deployment,
                protocol: { ...wire().deployment.protocol, fromBlock: Number.MAX_SAFE_INTEGER + 1 },
            },
        },
        {
            deployment: {
                ...wire().deployment,
                registry: { ...wire().deployment.registry, runtimeCodeHash: "0x" },
            },
        },
    ])("rejects malformed or foreign deployment without binding the client %j", async (patch) => {
        let bad = true;
        const { client } = setup(() => (bad ? { ...wire(), ...patch } : wire()), {
            deployment: undefined,
        });
        await expect(client.getDeployment(31337n)).rejects.toBeInstanceOf(ProtocolRpcError);
        bad = false;
        await expect(client.getDeployment(31337n)).resolves.toHaveProperty("chainId", 31337n);
    });
    it("rejects later configuration changes including registry pins", async () => {
        let changed = false;
        const { client } = setup(
            () => {
                const value = wire();
                if (changed) value.deployment.registry.runtimeCodeHash = h(8);
                return value;
            },
            { deployment: undefined }
        );
        const loaded = await client.getDeployment(31337n);
        changed = true;
        await expect(client.getDeployment(31337n)).rejects.toThrow(/pins mismatch/);
        expect(loaded.registry?.runtimeCodeHash).toBe(h(7));
    });
    it("accepts a service matching independent application pins", async () => {
        const { client } = setup(() => ({
            ...wire(),
            deployment: { ...status().deployment },
        }));
        await expect(client.getDeployment(31337n)).resolves.toEqual(deployment);
    });
    it("honors explicit application pins and cancellation", async () => {
        const { client } = setup(() => wire());
        await expect(client.getDeployment(31337n)).rejects.toThrow(/pins mismatch/);
        const controller = new AbortController();
        controller.abort();
        await expect(
            client.getDeployment(31337n, { signal: controller.signal })
        ).rejects.toMatchObject({ kind: "aborted" });
    });
});

describe("versioned service URLs", () => {
    it.each([
        ["https://example.org/v1", "https://example.org/v1/chains/31337"],
        [
            "https://example.org/proxy/v1/?access=opaque",
            "https://example.org/proxy/v1/chains/31337?access=opaque",
        ],
    ])("selects a chain from %s without changing the configured service", async (url, expected) => {
        const { client, fetchMock } = setup(() => status(), { url, deployment: undefined });
        expect((await client.getDeployment(31337n)).chainId).toBe(31337n);
        expect((await client.getStatus(context)).indexedHead).toEqual(block);
        expect((await client.getDeployment(31337n)).protocol.address).toBe(
            deployment.protocol.address
        );
        for (const call of vi.mocked(fetchMock).mock.calls) expect(call[0]).toBe(expected);
    });

    it("routes an independently pinned deployment without a discovery request", async () => {
        const { client, fetchMock, requests } = setup(() => status(), {
            url: "https://example.org/v1",
        });
        await client.getStatus(context);
        expect(requests.map((request) => request.method)).toEqual(["invisi_getStatus"]);
        expect(vi.mocked(fetchMock).mock.calls[0]?.[0]).toBe("https://example.org/v1/chains/31337");
    });
});
