import { encodeRlp, keccak256, toBeHex } from "ethers";
import { TrustedProvider } from "./TrustedProvider";
import { ProtocolRpcClient } from "./ProtocolRpcClient";
import { context, deployment, h, status } from "./ProtocolRpcClient-fixtures";
export function chain(count: number, start = 1n, extraData = "0x") {
    let parentHash = h(0);
    return Array.from({ length: count }, (_, i) => {
        const header = {
            parentHash,
            sha3Uncles: h(2),
            miner: `0x${"11".repeat(20)}`,
            stateRoot: h(3),
            transactionsRoot: h(4),
            receiptsRoot: h(5),
            logsBloom: `0x${"00".repeat(256)}`,
            difficulty: "0x0",
            number: `0x${(start + BigInt(i)).toString(16)}`,
            gasLimit: "0x100",
            gasUsed: "0x0",
            timestamp: "0x7b",
            extraData,
            mixHash: h(6),
            nonce: `0x${"00".repeat(8)}`,
        };
        const headerHash = keccak256(
            encodeRlp(
                Object.values(header).map((v, i) =>
                    [7, 8, 9, 10, 11].includes(i)
                        ? BigInt(v) === 0n
                            ? "0x"
                            : toBeHex(BigInt(v))
                        : v
                )
            )
        );
        parentHash = headerHash as typeof parentHash;
        return { header, headerHash };
    });
}
export function fixture(
    alter: (r: any) => any = (r) => r,
    error?: number | ((from: number) => number | undefined)
) {
    const headers = chain(513);
    const requests: any[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        requests.push(body);
        const respond = (request: any) => {
            if (request.method === "invisi_getBlockHeaders") {
                const code =
                    typeof error === "function" ? error(request.params[0].fromBlock) : error;
                if (code !== undefined)
                    return {
                        jsonrpc: "2.0",
                        id: request.id,
                        error: { code, message: "unavailable" },
                    };
                const { fromBlock, toBlock } = request.params[0];
                return {
                    jsonrpc: "2.0",
                    id: request.id,
                    result: alter({
                        ...status(),
                        range: { fromBlock, toBlock, blockHash: headers[toBlock - 1]!.headerHash },
                        headers: headers.slice(fromBlock - 1, toBlock),
                    }),
                };
            }
            return {
                jsonrpc: "2.0",
                id: request.id,
                result: {
                    ...status(),
                    ...headers[
                        (["latest", "safe", "finalized"].includes(request.params[0].block)
                            ? 1
                            : Number(BigInt(request.params[0].block))) - 1
                    ],
                },
            };
        };
        return new Response(
            JSON.stringify(Array.isArray(body) ? body.map(respond).reverse() : respond(body))
        );
    };
    const client = new ProtocolRpcClient({
        url: "https://rpc.example/v1",
        deployment,
        fetch: fetcher as typeof fetch,
    });
    return { reader: new TrustedProvider(client, context), requests, headers };
}
