import quoteVectors from "./testdata/broadcaster-v1.json";
const concreteData = quoteVectors[0]!.data;
import { Protocol as BaseProtocol } from "@invisi-labs/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { Protocol } from "../protocol/Protocol";
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as `0x${string}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as `0x${string}`;
const block = { number: 10n, hash: h(10), parentHash: h(9), timestamp: 100n };
const entry = (n: number) => ({
    operator: a(n),
    endpoint: `https://relay${n}.example/rpc`,
    metadataURI: "",
    quoteSigner: a(n + 10),
    feeRecipient: a(n + 20),
    enabled: true,
    block,
});
const deployment = {
    chainId: 97n,
    protocol: { address: a(100), runtimeCodeHash: h(1), fromBlock: 1n },
    broadcasterRegistry: { address: a(101), runtimeCodeHash: h(2), fromBlock: 2n },
};
afterEach(() => {
    vi.restoreAllMocks();
});
async function discover(rpc: unknown) {
    vi.spyOn(BaseProtocol, "fromRpc").mockResolvedValue(new BaseProtocol({ deployment }));
    return Protocol.fromRpc(rpc as never, {} as never);
}
it("discovers a token-compatible service across pages and pins its registered quote signer", async () => {
    const pages = vi
        .fn()
        .mockResolvedValueOnce({ block, broadcasters: [entry(1), entry(2)], next: a(2) })
        .mockResolvedValueOnce({ block, broadcasters: [entry(3)] });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const req = JSON.parse(init!.body as string);
        expect(req.params[0]).toEqual({ data: concreteData });
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                ...(String(url).includes("relay1")
                    ? { error: { code: -32000, message: "unsupported token" } }
                    : {
                          result: {
                              feeRecipient: entry(String(url).includes("relay2") ? 99 : 3)
                                  .feeRecipient,
                              feeAmount: "5",
                              maxGas: "1000",
                          },
                      }),
            })
        );
    });
    const rpc = { getDeployment: vi.fn().mockResolvedValue(deployment), getBroadcasters: pages };
    const protocol = await discover(rpc);
    const clients = await protocol.getBroadcasters({ data: concreteData });
    expect(clients).toHaveLength(1);
    const client = clients[0]!;
    expect(client.url).toBe(entry(3).endpoint);
    expect(client.configuration.quoteSigner).toBe(entry(3).quoteSigner);
    expect(pages.mock.calls[1]![0]).toMatchObject({ enabled: true, after: a(2), block });
    expect(fetcher).toHaveBeenCalledTimes(3);
});
it("returns all compatible services without a fee ceiling and skips disabled or insecure entries", async () => {
    const rpc = {
        getDeployment: async () => deployment,
        getBroadcasters: vi.fn().mockResolvedValue({
            block,
            broadcasters: [
                { ...entry(1), enabled: false },
                { ...entry(2), endpoint: "http://unsafe.example" },
                entry(3),
                entry(4),
            ],
        }),
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const req = JSON.parse(init!.body as string);
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                    feeRecipient: entry(String(url).includes("relay3") ? 3 : 4).feeRecipient,
                    feeAmount: "99999",
                    maxGas: "1000",
                },
            })
        );
    });
    const protocol = await discover(rpc);
    expect(await protocol.getBroadcasters({ data: concreteData })).toHaveLength(2);
});
it("requires a configured registry", async () => {
    const protocol = new Protocol({ deployment: { chainId: 97n, protocol: deployment.protocol } });
    await expect(protocol.getBroadcasters({ data: concreteData })).rejects.toThrow(/registry/i);
});
