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
const wireBlock = { number: 10, hash: h(10), parentHash: h(9), timestamp: 123 };
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
            n === 10n
                ? block
                : { ...block, number: n, hash: h(n), parentHash: h(n - 1n), timestamp: 123n }
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
                          { transactionHash: h(2), logIndex: 0, block: wireBlock },
                          { transactionHash: h(2), logIndex: 1, block: wireBlock },
                          { transactionHash: h(3), logIndex: 2, block: wireBlock },
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
                          {
                              output: { transactionHash: h(2), logIndex: 0, block: wireBlock },
                              fallback: true,
                          },
                      ],
                      creditTransitions: [{ transactionHash: h(3), logIndex: 1, block: wireBlock }],
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
    it("pins broadcaster registry metadata across discovery and cloned readers", async () => {
        let changed = false;
        const { client, reader } = setup(
            () => ({
                ...wire(),
                deployment: {
                    ...wire().deployment,
                    broadcasterRegistry: {
                        ...wire().deployment.registry,
                        runtimeCodeHash: h(changed ? 9 : 8),
                    },
                },
            }),
            { deployment: undefined }
        );
        const loaded = await client.getDeployment(31337n);
        expect(loaded.broadcasterRegistry?.runtimeCodeHash).toBe(h(8));
        const clone = client.withReader(reader);
        changed = true;
        await expect(client.getDeployment(31337n)).rejects.toThrow(/pins mismatch/);
        await expect(clone.getDeployment(31337n)).rejects.toThrow(/pins mismatch/);
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
                  outputs: [
                      {
                          transactionHash: h(2),
                          logIndex: 0,
                          block: { ...wireBlock, timestamp: 124 },
                      },
                  ],
                  creditTransitions: [],
              }
    );
    await expect(client.getUpdates(context, { fromBlock: 1n, toBlock: 10n })).rejects.toThrow(
        "canonical block mismatch"
    );
});

const encryptedOutput = () => ({
    block: wireBlock,
    treeId: "1",
    leafIndex: 3,
    commitment: h(12),
    token: "0x2222222222222222222222222222222222222222",
    ciphertext: "0x" + "01".repeat(160),
    clue: "0x" + "02".repeat(68),
    transactionHash: h(22),
    logIndex: 4,
    kind: "Transact",
});
it("returns canonical encrypted output fields without fetching receipts", async () => {
    const { client, requests } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [encryptedOutput()],
                  creditTransitions: [],
              }
    );
    const result = await client.getOutputs(context, { fromBlock: 10n, toBlock: 10n });
    expect(result.outputs[0]).toMatchObject({
        treeId: 1n,
        leafIndex: 3,
        commitment: h(12),
        ciphertext: encryptedOutput().ciphertext,
        block,
    });
    expect(requests.map((r) => r.method)).toEqual(["invisi_getStatus", "invisi_getUpdates"]);
});
it.each([
    { treeId: "0" },
    { leafIndex: 65536 },
    { token: "invalid" },
    { ciphertext: "0x" },
    { ciphertext: "0x" + "00".repeat(4097) },
    { clue: "0x12" },
    { clue: "0x" },
    { commitment: h(1n << 255n) },
    { transactionHash: "0x12" },
    { kind: "" },
    { block: { ...wireBlock, number: 9, hash: h(9), parentHash: h(8) } },
])("rejects malformed indexed outputs %j", async (patch) => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [{ ...encryptedOutput(), ...patch }],
                  creditTransitions: [],
              }
    );
    await expect(
        client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })
    ).rejects.toBeInstanceOf(ProtocolRpcError);
});
it("ignores identical indexed outputs", async () => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [encryptedOutput(), encryptedOutput()],
                  creditTransitions: [],
              }
    );
    expect(
        (await client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })).outputs
    ).toHaveLength(1);
});
it.each([true, false, "false"])("validates indexed spent observations %j", async (value) => {
    const { client } = setup(() => value);
    if (typeof value === "boolean") expect(await client.isSpent(context, h(1))).toBe(value);
    else await expect(client.isSpent(context, h(1))).rejects.toThrow(/spent/);
});

it("supports detected encrypted candidates and empty output pages", async () => {
    const { client, requests } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  checkedBits: 8,
                  candidates: [{ fallback: false, output: encryptedOutput() }],
                  creditTransitions: [],
              }
    );
    const result = await client.getOutputs(context, {
        fromBlock: 10n,
        toBlock: 10n,
        detectionKey: new Uint8Array(32).fill(1),
    });
    expect(result.outputs).toHaveLength(1);
    expect(requests[1]?.method).toBe("invisi_detectOutputs");
    const empty = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : { blockHash: h(10), outputs: null, creditTransitions: null }
    );
    expect(
        (await empty.client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })).outputs
    ).toEqual([]);
});

it.each([
    { leafIndex: 4 },
    { treeId: "2" },
    { commitment: h(13) },
    { token: "0x3333333333333333333333333333333333333333" },
    { ciphertext: "0x" + "03".repeat(160) },
    { clue: "0x" + "04".repeat(68) },
    { transactionHash: h(23) },
    { logIndex: 5 },
    { kind: "Shield" },
])("rejects conflicting indexed outputs %j", async (patch) => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [encryptedOutput(), { ...encryptedOutput(), ...patch }],
                  creditTransitions: [],
              }
    );
    await expect(client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })).rejects.toThrow(
        /Conflicting/
    );
});

it("deduplicates equivalent hex casing after output normalization", async () => {
    const output = {
        ...encryptedOutput(),
        ciphertext: "0x" + "ab".repeat(160),
        clue: "0x" + "cd".repeat(68),
    };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [
                      output,
                      {
                          ...output,
                          ciphertext: "0x" + "AB".repeat(160),
                          clue: "0x" + "CD".repeat(68),
                      },
                  ],
                  creditTransitions: [],
              }
    );
    expect(
        (await client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })).outputs
    ).toHaveLength(1);
});

it("does not confuse Credit role envelopes with conflicting funds outputs", async () => {
    const credit = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        ciphertext: "0x81" + "ab".repeat(753),
    };
    const change = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        leafIndex: 4,
        commitment: h(13),
        ciphertext: "0x01" + "ab".repeat(160),
    };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [credit, { ...credit, ciphertext: "0x81" + "cd".repeat(753) }, change],
                  creditTransitions: [],
              }
    );
    const page = await client.getOutputs(context, { fromBlock: 10n, toBlock: 10n });
    expect(page.outputs).toHaveLength(1);
    expect(page.outputs[0]?.commitment).toBe(h(13));
});

it("discovers both Credit role envelopes without collapsing a shared commitment", async () => {
    const credit = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        ciphertext: "0x81" + "ab".repeat(753),
    };
    const otherRole = { ...credit, ciphertext: "0x81" + "cd".repeat(753) };
    const { client, requests } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [
                      credit,
                      otherRole,
                      credit,
                      { ...encryptedOutput(), leafIndex: 4, commitment: h(13) },
                  ],
                  creditTransitions: [],
              }
    );
    const page = await client.getCreditOutputs(context, { fromBlock: 10n, toBlock: 10n });
    expect(page.outputs).toHaveLength(2);
    expect(page.outputs.map((output) => output.commitment)).toEqual([h(12), h(12)]);
    expect(requests.map((request) => request.method)).toEqual([
        "invisi_getStatus",
        "invisi_getUpdates",
    ]);
});
it.each([{ treeId: "2" }, { leafIndex: 4 }, { transactionHash: h(99) }, { commitment: h(13) }])(
    "rejects conflicting Credit envelope metadata %j",
    async (patch) => {
        const credit = {
            ...encryptedOutput(),
            kind: "CreditDraw",
            ciphertext: "0x81" + "ab".repeat(753),
        };
        const { client } = setup((method) =>
            method === "invisi_getStatus"
                ? status()
                : {
                      blockHash: h(10),
                      outputs: [
                          credit,
                          { ...credit, ...patch, ciphertext: "0x81" + "cd".repeat(753) },
                      ],
                      creditTransitions: [],
                  }
        );
        await expect(
            client.getCreditOutputs(context, { fromBlock: 10n, toBlock: 10n })
        ).rejects.toThrow(/Conflicting/);
    }
);
it("rejects more than two distinct Credit role envelopes for one leaf", async () => {
    const credit = { ...encryptedOutput(), kind: "CreditToppedUp" };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: ["ab", "cd", "ef"].map((byte) => ({
                      ...credit,
                      ciphertext: "0x81" + byte.repeat(753),
                  })),
                  creditTransitions: [],
              }
    );
    await expect(
        client.getCreditOutputs(context, { fromBlock: 10n, toBlock: 10n })
    ).rejects.toThrow(/Credit role/);
});

it("rejects changed clues for an otherwise identical Credit envelope", async () => {
    const credit = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        ciphertext: "0x81" + "ab".repeat(753),
    };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [credit, { ...credit, clue: "0x" + "cd".repeat(68) }],
                  creditTransitions: [],
              }
    );
    await expect(
        client.getCreditOutputs(context, { fromBlock: 10n, toBlock: 10n })
    ).rejects.toThrow(/Conflicting Credit/);
});

it("preserves unregistered versions in raw and typed candidates without a codec registry", async () => {
    const funds = { ...encryptedOutput(), ciphertext: "0x02" + "ab".repeat(200) };
    const owner = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        leafIndex: 4,
        commitment: h(13),
        ciphertext: "0x82" + "cd".repeat(600),
    };
    const spender = { ...owner, ciphertext: "0x82" + "ef".repeat(600) };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [funds, owner, spender],
                  creditTransitions: [],
              }
    );
    const range = { fromBlock: 10n, toBlock: 10n };
    expect(
        (await client.getEncryptedOutputs(context, range)).outputs.map((entry) => entry.ciphertext)
    ).toEqual([funds.ciphertext, owner.ciphertext, spender.ciphertext]);
    expect((await client.getOutputs(context, range)).outputs).toHaveLength(1);
    expect((await client.getCreditOutputs(context, range)).outputs).toHaveLength(2);
});

const transactionWire = (state = "indexed") => ({
    transactionHash: h(123),
    status: state,
    indexedHead: wireBlock,
    ...(state === "not_found" ? {} : { blockNumber: 10, blockHash: h(10), receiptStatus: 1 }),
    outputs: state === "indexed" ? [] : null,
    creditTransitions: state === "indexed" ? [] : null,
});
const transactionOutput = () => ({
    block: wireBlock,
    treeId: 1,
    leafIndex: 0,
    commitment: h(1),
    token: "0x2222222222222222222222222222222222222222",
    ciphertext: "0x01",
    clue: "0x" + "00".repeat(68),
    transactionHash: h(123),
    logIndex: 1,
    kind: "Shield",
});

describe("transaction updates", () => {
    it("preserves a stale indexed checkpoint for pending_index without weakening getStatus", async () => {
        const stale = { ...wireBlock, hash: h(99) };
        const { client } = setup((method) =>
            method === "invisi_getStatus"
                ? { ...status(), indexedHead: stale }
                : { ...transactionWire("pending_index"), indexedHead: stale }
        );
        await expect(client.getTransactionUpdates(context, h(123))).resolves.toMatchObject({
            status: "pending_index",
            indexedHead: { hash: h(99) },
            block: { hash: h(10) },
        });
        await expect(client.getStatus(context)).rejects.toThrow("canonical block mismatch");
    });

    it("preserves reverted indexed transactions and detects a reorg during a read", async () => {
        const { client, reader } = setup((method) =>
            method === "invisi_getStatus" ? status() : { ...transactionWire(), receiptStatus: 0 }
        );
        expect(await client.getTransactionUpdates(context, h(123))).toMatchObject({
            status: "indexed",
            receiptStatus: 0,
            outputs: [],
        });
        let reads = 0;
        reader.getBlock.mockImplementation(async () => ({
            ...block,
            hash: ++reads === 3 ? h(99) : block.hash,
        }));
        await expect(client.getTransactionUpdates(context, h(123))).rejects.toThrow(
            "changed during query"
        );
    });
    it("rejects conflicting duplicate Credit transitions", async () => {
        const event = {
            block: wireBlock,
            name: "CreditDraw",
            transactionHash: h(123),
            logIndex: 2,
            data: { amount: "10" },
        };
        const { client } = setup((method) =>
            method === "invisi_getStatus"
                ? status()
                : {
                      ...transactionWire(),
                      creditTransitions: [event, { ...event, data: { amount: "11" } }],
                  }
        );
        await expect(client.getTransactionUpdates(context, h(123))).rejects.toThrow(
            "Conflicting Credit transition"
        );
    });

    it.each(["not_found", "pending_index", "indexed"])("preserves %s state", async (state) => {
        const { client, requests } = setup((method) =>
            method === "invisi_getStatus" ? status() : transactionWire(state)
        );
        const result = await client.getTransactionUpdates(context, h(123));
        expect(result.status).toBe(state);
        expect(result.outputs).toEqual(state === "indexed" ? [] : null);
        expect(result.block).toEqual(state === "not_found" ? null : block);
        expect(requests.at(-1)).toMatchObject({
            method: "invisi_getTransactionUpdates",
            params: [h(123)],
        });
    });
    it("normalizes outputs and Credit transitions without extra range requests", async () => {
        const { client, requests } = setup((method) =>
            method === "invisi_getStatus"
                ? status()
                : {
                      ...transactionWire(),
                      outputs: [transactionOutput(), transactionOutput()],
                      creditTransitions: [
                          {
                              block: wireBlock,
                              name: "CreditDraw",
                              transactionHash: h(123),
                              logIndex: 2,
                              data: { amount: "10" },
                          },
                      ],
                  }
        );
        const result = await client.getTransactionUpdates(context, h(123));
        expect(result.status).toBe("indexed");
        if (result.status !== "indexed") throw new Error("Expected indexed result");
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0]).toMatchObject({ treeId: 1n, block, transactionHash: h(123) });
        expect(result.creditTransitions[0]).toMatchObject({
            block,
            name: "CreditDraw",
            data: { amount: "10" },
        });
        expect(requests.map((r) => r.method)).toEqual([
            "invisi_getStatus",
            "invisi_getTransactionUpdates",
        ]);
    });
    it.each([
        { status: "unknown" },
        { transactionHash: h(9) },
        { blockHash: h(9) },
        { receiptStatus: 2 },
        { outputs: null },
        { indexedHead: null },
        { outputs: [{ ...transactionOutput(), transactionHash: h(99) }] },
        {
            outputs: [
                {
                    ...transactionOutput(),
                    block: { ...wireBlock, number: 9, hash: h(9), parentHash: h(8) },
                },
            ],
        },
        { outputs: [{ ...transactionOutput(), ciphertext: "0x" }] },
        {
            creditTransitions: [
                { block: wireBlock, name: "Other", transactionHash: h(123), logIndex: 1, data: {} },
            ],
        },
        {
            creditTransitions: [
                {
                    block: wireBlock,
                    name: "CreditDraw",
                    transactionHash: h(9),
                    logIndex: 1,
                    data: {},
                },
            ],
        },
        {
            creditTransitions: [
                {
                    block: { ...wireBlock, hash: h(9) },
                    name: "CreditDraw",
                    transactionHash: h(123),
                    logIndex: 1,
                    data: {},
                },
            ],
        },
        { status: "pending_index", outputs: [], creditTransitions: null },
        { status: "not_found", outputs: null, creditTransitions: null },
    ])("rejects inconsistent responses %j", async (patch) => {
        const { client } = setup((method) =>
            method === "invisi_getStatus" ? status() : { ...transactionWire(), ...patch }
        );
        await expect(client.getTransactionUpdates(context, h(123))).rejects.toBeInstanceOf(
            ProtocolRpcError
        );
    });
    it("rejects invalid hashes before network I/O and supports abort", async () => {
        const { client, requests } = setup(() => status());
        await expect(client.getTransactionUpdates(context, h(0))).rejects.toBeInstanceOf(
            ProtocolRpcError
        );
        await expect(client.getTransactionUpdates(context, "0x12")).rejects.toBeInstanceOf(
            ProtocolRpcError
        );
        expect(requests).toHaveLength(0);
        const controller = new AbortController();
        controller.abort();
        await expect(
            client.getTransactionUpdates(context, h(123), { signal: controller.signal })
        ).rejects.toMatchObject({ kind: "aborted" });
    });
});

it("preserves mixed empty Funds outputs and classifies empty Credit change as Funds", async () => {
    const outputs = [
        { ...encryptedOutput(), ciphertext: "0x", clue: "0x" },
        { ...encryptedOutput(), leafIndex: 4, commitment: h(13) },
        {
            ...encryptedOutput(),
            kind: "CreditCreated",
            leafIndex: 5,
            commitment: h(14),
            ciphertext: "0x",
            clue: "0x",
        },
        {
            ...encryptedOutput(),
            kind: "CreditCreated",
            leafIndex: 6,
            commitment: h(15),
            ciphertext: "0x81" + "ab".repeat(753),
        },
    ];
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : { blockHash: h(10), outputs, creditTransitions: [] }
    );
    const range = { fromBlock: 10n, toBlock: 10n };
    expect(
        (await client.getOutputs(context, range)).outputs.map((output) => output.leafIndex)
    ).toEqual([3, 4, 5]);
    expect(
        (await client.getCreditOutputs(context, range)).outputs.map((output) => output.leafIndex)
    ).toEqual([6]);
    expect(
        (await client.getEncryptedOutputs(context, range)).outputs.map((output) => output.leafIndex)
    ).toEqual([3, 4, 5, 6]);
});

it("preserves an empty Funds envelope in transaction updates", async () => {
    const output = { ...transactionOutput(), ciphertext: "0x", clue: "0x" };
    const { client } = setup((method) =>
        method === "invisi_getStatus" ? status() : { ...transactionWire(), outputs: [output] }
    );
    expect((await client.getTransactionUpdates(context, h(123))).outputs).toMatchObject([
        { leafIndex: 0, ciphertext: "0x", clue: "0x" },
    ]);
});
