import type { Hex } from "@invisi-labs/primitives";
import { vi } from "vitest";
import type { ProtocolDeployment } from "../deployment/deployment";
import { ProtocolRpcClient, type ProtocolRpcReader } from "./ProtocolRpcClient";

export const h = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;

export const deployment: ProtocolDeployment = {
    chainId: 31337n,
    protocol: {
        address: "0x1111111111111111111111111111111111111111",
        runtimeCodeHash: h(9),
        fromBlock: 1n,
    },
};

export const context = {
    chainId: deployment.chainId,
    protocolAddress: deployment.protocol.address,
};

export const block = { number: 10n, hash: h(10), parentHash: h(9), timestamp: 123n };

export const wireBlock = { number: 10, hash: h(10), parentHash: h(9), timestamp: 123 };

export const status = () => ({
    apiVersion: "v1",
    protocolVersion: "1",
    deployment: {
        chainId: "31337",
        protocol: { address: deployment.protocol.address, runtimeCodeHash: h(9), fromBlock: 1 },
    },
    indexedHead: wireBlock,
});

export function setup(
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

export const encryptedOutput = () => ({
    block: wireBlock,
    treeId: "1",
    leafIndex: 3,
    commitment: h(12),
    token: "0x2222222222222222222222222222222222222222",
    ciphertext: "0x" + "01".repeat(160),
    clue: "0x" + "02".repeat(68),
    transactionHash: h(22),
    logIndex: 4,
    kind: "NoteOutputs",
});

export const transactionWire = (state = "indexed") => ({
    transactionHash: h(123),
    status: state,
    indexedHead: wireBlock,
    ...(state === "not_found" ? {} : { blockNumber: 10, blockHash: h(10), receiptStatus: 1 }),
    notes: state === "indexed" ? [] : null,
    states: state === "indexed" ? [] : null,
    transitions: state === "indexed" ? [] : null,
});

export const transactionOutput = () => ({
    block: wireBlock,
    treeId: 1,
    leafIndex: 0,
    commitment: h(1),
    token: "0x2222222222222222222222222222222222222222",
    ciphertext: "0x01",
    clue: "0x" + "00".repeat(68),
    transactionHash: h(123),
    logIndex: 1,
    kind: "NoteOutputs",
});
