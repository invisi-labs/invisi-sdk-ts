import type { Hex } from "@invisi-labs/primitives";
import type { Provider } from "ethers";
import { expect, it, vi } from "vitest";
import { ProtocolRpcClient } from "./ProtocolRpcClient";

it("checks indexed heads against the supplied provider and rejects a forged block", async () => {
    const hash = `0x${"01".repeat(32)}` as Hex;
    const address = `0x${"11".repeat(20)}` as const;
    const deployment = {
        chainId: 31337n,
        protocol: { address, runtimeCodeHash: hash, fromBlock: 0n },
    };
    const getBlock = vi.fn(async () => ({ number: 1, hash, parentHash: hash, timestamp: 0 }));
    const provider = { getBlock } as unknown as Provider;
    const rpc = new ProtocolRpcClient({
        url: "http://localhost/v1",
        deployment,
        fetch: async (_url, init) => {
            const { id } = JSON.parse(init!.body as string);
            return Response.json({
                jsonrpc: "2.0",
                id,
                result: {
                    apiVersion: "v1",
                    protocolVersion: "1",
                    deployment: {
                        chainId: "31337",
                        protocol: { ...deployment.protocol, fromBlock: 0 },
                    },
                    indexedHead: { number: 1, hash, parentHash: hash, timestamp: 0 },
                },
            });
        },
    });
    const verified = rpc.withProvider(provider);
    const context = { chainId: 31337n, protocolAddress: address };
    expect((await verified.getStatus(context)).indexedHead?.number).toBe(1n);
    expect(getBlock).toHaveBeenCalledWith(1n);
    getBlock.mockResolvedValue({
        number: 1,
        hash: `0x${"02".repeat(32)}`,
        parentHash: hash,
        timestamp: 0,
    });
    await expect(verified.getStatus(context)).rejects.toThrow(/canonical block mismatch/);
});
