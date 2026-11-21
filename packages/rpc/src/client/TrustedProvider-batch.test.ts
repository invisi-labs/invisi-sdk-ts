import { expect, it, vi } from "vitest";
import { encodeRlp, keccak256, toBeHex } from "ethers";
import { TrustedProvider } from "./TrustedProvider";
import { ProtocolRpcClient } from "./ProtocolRpcClient";
import { context, deployment, h, status } from "./ProtocolRpcClient-fixtures";
function wire(n: bigint) {
    const raw = {
        parentHash: h(n - 1n),
        sha3Uncles: h(2),
        miner: `0x${"11".repeat(20)}`,
        stateRoot: h(3),
        transactionsRoot: h(4),
        receiptsRoot: h(5),
        logsBloom: `0x${"00".repeat(256)}`,
        difficulty: "0x0",
        number: `0x${n.toString(16)}`,
        gasLimit: "0x100",
        gasUsed: "0x0",
        timestamp: "0x7b",
        extraData: "0x",
        mixHash: h(6),
        nonce: `0x${"00".repeat(8)}`,
    };
    const hash = keccak256(
        encodeRlp(
            Object.values(raw).map((v, i) =>
                [7, 8, 9, 10, 11].includes(i) ? (BigInt(v) === 0n ? "0x" : toBeHex(BigInt(v))) : v
            )
        )
    );
    return { ...status(), header: raw, headerHash: hash };
}
function fixture(alter: (responses: any[]) => unknown = (r) => r.reverse()) {
    const fetcher = vi.fn(async (_url, init) => {
        const body = JSON.parse(init.body);
        expect(Array.isArray(body)).toBe(true);
        const response = body.map((r: any) => ({
            jsonrpc: "2.0",
            id: r.id,
            result: wire(BigInt(r.params[0].block)),
        }));
        return new Response(JSON.stringify(alter(response)));
    });
    const client = new ProtocolRpcClient({
        url: "https://rpc.example/v1",
        deployment,
        fetch: fetcher as typeof fetch,
    });
    return { reader: new TrustedProvider(client, context), fetcher };
}
it("batches full headers in bounded groups and restores request order", async () => {
    const f = fixture();
    const numbers = Array.from({ length: 45 }, (_, i) => BigInt(i * 2 + 1));
    const blocks = await f.reader.getBlocks(numbers);
    expect(blocks.map((b) => b.number)).toEqual(numbers);
    expect(f.fetcher.mock.calls.map(([, init]) => JSON.parse(init.body).length)).toEqual([
        20, 20, 5,
    ]);
});
it.each([
    ["duplicate IDs", (r: any[]) => [r[0], r[0]]],
    ["missing response", (r: any[]) => r.slice(0, 1)],
    ["unknown ID", (r: any[]) => [{ ...r[0], id: 999 }, r[1]]],
    [
        "partial error",
        (r: any[]) => [
            { jsonrpc: "2.0", id: r[0].id, error: { code: -32000, message: "secret" } },
            r[1],
        ],
    ],
    [
        "deployment mismatch",
        (r: any[]) => [{ ...r[0], result: { ...r[0].result, protocolVersion: "2" } }, r[1]],
    ],
    [
        "corrupt full header",
        (r: any[]) => [{ ...r[0], result: { ...r[0].result, headerHash: h(999) } }, r[1]],
    ],
])("rejects %s without accepting a partial header set", async (_label, alter) => {
    await expect(fixture(alter).reader.getBlocks([1n, 3n])).rejects.toThrow();
});
