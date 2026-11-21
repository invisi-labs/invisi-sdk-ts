import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { chain } from "./TrustedProvider-history-fixtures";
import { context, deployment, status } from "./ProtocolRpcClient-fixtures";

// Exercise independent public CommonJS bundles, where module-local error
// constructors have distinct identities. The normal turbo test task builds first.
const require = createRequire(import.meta.url);
const { ProtocolRpcClient } = require("@invisi-labs/rpc");
const { TrustedProvider } = require("@invisi-labs/rpc/trusted-provider");

function fixture(errorResponse: (request: any) => unknown) {
    const headers = chain(2);
    const requests: any[] = [];
    const client = new ProtocolRpcClient({
        url: "https://rpc.example/v1",
        deployment,
        fetch: async (_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            requests.push(body);
            if (!Array.isArray(body)) return new Response(JSON.stringify(errorResponse(body)));
            return new Response(
                JSON.stringify(
                    body.map((r) => ({
                        jsonrpc: "2.0",
                        id: r.id,
                        result: { ...status(), ...headers[Number(BigInt(r.params[0].block)) - 1] },
                    }))
                )
            );
        },
    });
    return { reader: new TrustedProvider(client, context), requests };
}
it.each([-32601, -32004])(
    "CommonJS public entrypoints fall back for validated RPC %s",
    async (code) => {
        const f = fixture((r) => ({
            jsonrpc: "2.0",
            id: r.id,
            error: { code, message: "unavailable" },
        }));
        expect((await f.reader.getBlocks([1n, 2n])).map((b: any) => b.number)).toEqual([1n, 2n]);
        expect(f.requests).toHaveLength(2);
        expect(f.requests[1].map((r: any) => r.method)).toEqual([
            "invisi_readChainState",
            "invisi_readChainState",
        ]);
    }
);
it.each([
    [
        "ambiguous envelope",
        (r: any) => ({
            jsonrpc: "2.0",
            id: r.id,
            result: null,
            error: { code: -32601, message: "unavailable" },
        }),
    ],
    ["missing error message", (r: any) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32004 } })],
    [
        "wrong response ID",
        (r: any) => ({
            jsonrpc: "2.0",
            id: r.id + 1,
            error: { code: -32601, message: "unavailable" },
        }),
    ],
    [
        "wrong error code type",
        (r: any) => ({
            jsonrpc: "2.0",
            id: r.id,
            error: { code: "-32004", message: "unavailable" },
        }),
    ],
    [
        "ordinary RPC failure",
        (r: any) => ({ jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "unavailable" } }),
    ],
    [
        "invalid success response",
        (r: any) => ({ jsonrpc: "2.0", id: r.id, result: { ...status(), headers: [] } }),
    ],
])("CommonJS public entrypoints fail closed on %s", async (_name, response) => {
    const f = fixture(response);
    await expect(f.reader.getBlocks([1n, 2n])).rejects.toThrow();
    expect(f.requests).toHaveLength(1);
});
