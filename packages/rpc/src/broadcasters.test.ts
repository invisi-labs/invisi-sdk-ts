import { describe, expect, it } from "vitest";
import { ProtocolRpcClient } from "./ProtocolRpcClient";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const block = { number: 12, hash: h(12), parentHash: h(11), timestamp: 123 };
const entry = {
    operator: a(1),
    endpoint: "https://relay.example/rpc",
    metadataURI: "",
    quoteSigner: a(2),
    feeRecipient: a(3),
    enabled: false,
    block,
};
function client(result: unknown, registry = true) {
    const requests: unknown[] = [];
    const rpc = new ProtocolRpcClient({
        url: "https://example.org/v1",
        deployment: {
            chainId: 97n,
            protocol: { address: a(4), runtimeCodeHash: h(1), fromBlock: 1n },
            ...(registry
                ? { broadcasterRegistry: { address: a(5), runtimeCodeHash: h(2), fromBlock: 2n } }
                : {}),
        },
        fetch: async (_, init) => {
            const request = JSON.parse(init!.body as string);
            requests.push(request);
            return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        },
    });
    return { rpc, requests };
}
describe("broadcaster discovery", () => {
    it("reads validated registry entries with positional queries and a pinned page anchor", async () => {
        const { rpc, requests } = client({ block, broadcasters: [entry], next: a(1) });
        const page = await rpc.getBroadcasters({ enabled: false, limit: 1 });
        expect(page.block.number).toBe(12n);
        expect(page.broadcasters).toEqual([
            { ...entry, block: { ...block, number: 12n, timestamp: 123n } },
        ]);
        expect(page.next).toBe(a(1));
        const later = client({ block, broadcasters: [{ ...entry, operator: a(2) }] });
        await later.rpc.getBroadcasters({
            enabled: false,
            limit: 1,
            after: page.next!,
            block: page.block,
        });
        expect(later.requests[0]).toMatchObject({
            params: [{ enabled: false, limit: 1, after: a(1), block }],
        });
        expect(requests[0]).toEqual({
            jsonrpc: "2.0",
            id: 1,
            method: "invisi_getBroadcasters",
            params: [{ enabled: false, limit: 1 }],
        });
    });
    it("preserves contract-valid declarations without letting an unusable endpoint poison discovery", async () => {
        const endpoints = [
            "https://relay.example/#x",
            "https://user@relay.example",
            "https://?",
            entry.endpoint,
        ];
        const broadcasters = endpoints.map((endpoint, index) => ({
            ...entry,
            operator: a(index + 1),
            endpoint,
        }));
        const page = await client({ block, broadcasters }).rpc.getBroadcasters();
        expect(page.broadcasters).toEqual(
            broadcasters.map((item) => ({
                ...item,
                block: { ...block, number: 12n, timestamp: 123n },
            }))
        );
        expect(page.broadcasters.at(-1)?.endpoint).toBe(entry.endpoint);
    });
    it("rejects invalid query bounds, cursor without anchor and absent deployment", async () => {
        const { rpc, requests } = client({ block, broadcasters: [] });
        for (const query of [{ limit: 0 }, { limit: 101 }, { after: a(1) }, { enabled: "yes" }]) {
            await expect(rpc.getBroadcasters(query as never)).rejects.toThrow();
        }
        expect(requests).toHaveLength(0);
        await expect(client(null, false).rpc.getBroadcasters()).rejects.toThrow(/registry/i);
    });
    it("rejects malformed, unfiltered, unordered or substituted pages", async () => {
        for (const result of [
            { block: { ...block, number: 1 }, broadcasters: [] },
            { block, broadcasters: [{ ...entry, endpoint: "http://relay.example" }] },
            { block, broadcasters: [{ ...entry, quoteSigner: a(0) }] },
            { block, broadcasters: [{ ...entry, enabled: true }] },
            { block, broadcasters: [{ ...entry, block: undefined }] },
            { block, broadcasters: [{ ...entry, block: { ...block, number: 13 } }] },
            { block, broadcasters: [{ ...entry, block: { ...block, hash: h(99) } }] },
            { block, broadcasters: [entry, entry] },
            { block, broadcasters: [entry], next: a(2) },
            { block, broadcasters: [], next: a(1) },
            { block, broadcasters: [entry], unexpected: true },
        ])
            await expect(client(result).rpc.getBroadcasters({ enabled: false })).rejects.toThrow();
        await expect(
            client({ block, broadcasters: [] }).rpc.getBroadcasters({
                block: { ...block, number: 12n, timestamp: 123n, hash: h(99) },
            })
        ).rejects.toThrow();
    });
});
