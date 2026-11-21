import { expect, it, vi } from "vitest";
import { TrustedProvider } from "./TrustedProvider";
import { ProtocolRpcClient } from "./ProtocolRpcClient";
import { chain, fixture } from "./TrustedProvider-history-fixtures";
import { context, deployment, h, status } from "./ProtocolRpcClient-fixtures";

it("reads consecutive full historical headers with inclusive numeric ranges chunked at 256", async () => {
    const f = fixture();
    const numbers = Array.from({ length: 513 }, (_, i) => BigInt(i + 1));
    const blocks = await f.reader.getBlocks(numbers);
    expect(blocks.map((b) => b.number)).toEqual(numbers);
    expect(blocks[1]!.parentHash).toBe(blocks[0]!.hash);
    expect(f.requests.map((r) => ({ method: r.method, params: r.params }))).toEqual([
        { method: "invisi_getBlockHeaders", params: [{ fromBlock: 1, toBlock: 256 }] },
        { method: "invisi_getBlockHeaders", params: [{ fromBlock: 257, toBlock: 512 }] },
        { method: "invisi_getBlockHeaders", params: [{ fromBlock: 513, toBlock: 513 }] },
    ]);
});
it.each([-32601, -32004])("falls back to live batched reads only for RPC %s", async (code) => {
    const f = fixture(undefined, code);
    expect((await f.reader.getBlocks([1n, 2n])).map((b) => b.number)).toEqual([1n, 2n]);
    expect(f.requests[0].method).toBe("invisi_getBlockHeaders");
    expect(f.requests[1].map((r: any) => r.method)).toEqual([
        "invisi_readChainState",
        "invisi_readChainState",
    ]);
});
it.each([
    ["wrong count", (r: any) => ({ ...r, headers: r.headers.slice(1) })],
    ["wrong order", (r: any) => ({ ...r, headers: [...r.headers].reverse() })],
    [
        "wrong hash",
        (r: any) => ({ ...r, headers: [{ ...r.headers[0], headerHash: h(99) }, r.headers[1]] }),
    ],
    [
        "incomplete header",
        (r: any) => ({
            ...r,
            headers: [
                { ...r.headers[0], header: { ...r.headers[0].header, nonce: undefined } },
                r.headers[1],
            ],
        }),
    ],
    [
        "disconnected parents",
        (r: any) => {
            const other = chain(1, 2n)[0];
            return {
                ...r,
                headers: [r.headers[0], other],
                range: { ...r.range, blockHash: other!.headerHash },
            };
        },
    ],
    ["wrong anchor", (r: any) => ({ ...r, range: { ...r.range, blockHash: h(99) } })],
    ["wrong range", (r: any) => ({ ...r, range: { ...r.range, fromBlock: 0 } })],
    ["string range", (r: any) => ({ ...r, range: { ...r.range, fromBlock: "1" } })],
    ["wrong version", (r: any) => ({ ...r, apiVersion: "v2" })],
    [
        "wrong deployment",
        (r: any) => ({
            ...r,
            deployment: {
                ...r.deployment,
                protocol: { ...r.deployment.protocol, runtimeCodeHash: h(100) },
            },
        }),
    ],
])("fails closed on %s without live fallback", async (_name, alter) => {
    const f = fixture(alter);
    await expect(f.reader.getBlocks([1n, 2n])).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
});
it.each([-32000, -32602])("does not fallback on RPC %s", async (code) => {
    const f = fixture(undefined, code);
    await expect(f.reader.getBlocks([1n, 2n])).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
});
it("rejects invalid heights before networking and preserves empty reads", async () => {
    const f = fixture();
    expect(await f.reader.getBlocks([])).toEqual([]);
    for (const values of [[-1n], [1n, -1n], [1n << 63n], ["latest"]]) {
        await expect(f.reader.getBlocks(values as bigint[])).rejects.toThrow();
    }
    expect(f.requests).toHaveLength(0);
});
it("keeps single-header canonical and contract rechecks live after historical reads", async () => {
    const f = fixture();
    const [historical] = await f.reader.getBlocks([1n]);
    f.headers[0] = chain(1, 1n, "0x01")[0]!;
    expect((await f.reader.getBlock(1n)).hash).not.toBe(historical!.hash);
    await expect(f.reader.isKnownRoot(context, 1n, h(1), historical!)).rejects.toThrow(
        /block mismatch/
    );
    expect((await f.reader.getBlockByTag("latest"))!.hash).toBe(f.headers[0]!.headerHash);
    expect(f.requests.slice(1).map((r) => r.method)).toEqual([
        "invisi_readChainState",
        "invisi_readChainState",
        "invisi_readChainState",
    ]);
});
it("uses exact hexadecimal live reads for heights above JSON safe integers", async () => {
    const number = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    const full = chain(1, number)[0]!;
    const requests: any[] = [];
    const fetcher = vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        return new Response(
            JSON.stringify(
                body.map((r: any) => ({
                    jsonrpc: "2.0",
                    id: r.id,
                    result: { ...status(), ...full },
                }))
            )
        );
    });
    const client = new ProtocolRpcClient({
        url: "https://rpc.example/v1",
        deployment,
        fetch: fetcher as typeof fetch,
    });
    expect((await new TrustedProvider(client, context).getBlocks([number]))[0]!.number).toBe(
        number
    );
    expect(requests[0][0].params).toEqual([{ kind: "header", block: "0x20000000000000" }]);
});
it("checks parent continuity across historical response chunks", async () => {
    const f = fixture((r) => {
        if (r.range.fromBlock === 257) {
            const other = chain(1, 257n)[0]!;
            return { ...r, headers: [other], range: { ...r.range, blockHash: other.headerHash } };
        }
        return r;
    });
    await expect(
        f.reader.getBlocks(Array.from({ length: 257 }, (_, i) => BigInt(i + 1)))
    ).rejects.toThrow(/parent/);
    expect(f.requests).toHaveLength(2);
});

// Hash cross-checked with go-ethereum v1.17.2 types.Header.Hash, independently
// of this SDK's RLP decoder, including all fork fields through slotNumber.
const richHeader = {
    header: {
        ...chain(1)[0]!.header,
        baseFeePerGas: "0x0",
        withdrawalsRoot: h(7),
        blobGasUsed: "0x0",
        excessBlobGas: "0x0",
        parentBeaconBlockRoot: h(8),
        requestsHash: h(9),
        slotNumber: "0xa",
    },
    headerHash: "0x1840a20a2da071d939eb5142302d6e1a0b0ab4533a60168569ecb682734967d7",
};
it("verifies a full rich header through slotNumber in historical and live reads", async () => {
    const f = fixture((r) => ({
        ...r,
        headers: [richHeader],
        range: { ...r.range, blockHash: richHeader.headerHash },
    }));
    expect((await f.reader.getBlocks([1n]))[0]!.hash).toBe(richHeader.headerHash);
    f.headers[0] = richHeader;
    expect((await f.reader.getBlock(1n)).hash).toBe(richHeader.headerHash);
    expect(f.requests[1].method).toBe("invisi_readChainState");
});
it.each([
    "baseFeePerGas",
    "withdrawalsRoot",
    "blobGasUsed",
    "excessBlobGas",
    "parentBeaconBlockRoot",
    "requestsHash",
])("rejects missing or null %s before slotNumber without fallback", async (field) => {
    for (const absent of [undefined, null]) {
        const f = fixture((r) => ({
            ...r,
            headers: [{ ...richHeader, header: { ...richHeader.header, [field]: absent } }],
            range: { ...r.range, blockHash: richHeader.headerHash },
        }));
        await expect(f.reader.getBlocks([1n])).rejects.toThrow(/fork fields/);
        expect(f.requests).toHaveLength(1);
    }
});
it("binds slotNumber itself to the complete RLP hash", async () => {
    const f = fixture((r) => ({
        ...r,
        headers: [{ ...richHeader, header: { ...richHeader.header, slotNumber: "0xb" } }],
        range: { ...r.range, blockHash: richHeader.headerHash },
    }));
    await expect(f.reader.getBlocks([1n])).rejects.toThrow(/hash/);
    expect(f.requests).toHaveLength(1);
});

it("discards partial historical chunks and restarts every live read on later missing history", async () => {
    const oldHash = chain(1)[0]!.headerHash;
    const replacement = chain(257, 1n, "0x01");
    const f = fixture(
        (r) => {
            // Simulate a reorg between the first historical chunk and unavailable history.
            f.headers.splice(0, 257, ...replacement);
            return r;
        },
        (from) => (from >= 257 ? -32004 : undefined)
    );
    const numbers = Array.from({ length: 257 }, (_, i) => BigInt(i + 1));
    const blocks = await f.reader.getBlocks(numbers);
    expect(blocks.map((b) => b.number)).toEqual(numbers);
    expect(blocks[0]!.hash).not.toBe(oldHash);
    expect(blocks[0]!.hash).toBe(replacement[0]!.headerHash);
    for (let i = 1; i < blocks.length; i++) expect(blocks[i]!.parentHash).toBe(blocks[i - 1]!.hash);
    expect(f.requests.slice(0, 2).map((r) => r.method)).toEqual([
        "invisi_getBlockHeaders",
        "invisi_getBlockHeaders",
    ]);
    expect(f.requests.slice(2).map((r) => r.length)).toEqual([...Array(12).fill(20), 16, 1]);
    const live = f.requests.slice(2).flat();
    expect(live.map((r) => r.method)).toEqual(Array(257).fill("invisi_readChainState"));
    expect(live.map((r) => BigInt(r.params[0].block))).toEqual(numbers);
    expect(f.requests.flat().map((r) => r.id)).toEqual(
        Array.from({ length: 259 }, (_, i) => i + 1)
    );
});
