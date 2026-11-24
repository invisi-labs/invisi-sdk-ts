import { Protocol as BaseProtocol } from "@invisi-labs/rpc";
import { afterEach, expect, it, vi } from "vitest";
import { Protocol } from "../protocol/Protocol";
const tokenAddress = "0x0000000000000000000000000000000000000042";
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
function serviceStatus(n: number) {
    return {
        apiVersion: "v1",
        protocolVersion: "1",
        chainId: "97",
        protocol: deployment.protocol.address,
        sender: entry(n).quoteSigner,
        feeRecipient: entry(n).feeRecipient,
        submissionHalted: false,
        provenance: { enabled: false },
        tokenAddress,
        supported: true,
    };
}
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
        expect(req.method).toBe("broadcaster_getTokenSupport");
        expect(req.params[0]).toEqual({ tokenAddress });
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                ...(String(url).includes("relay1")
                    ? { error: { code: -32000, message: "unsupported token" } }
                    : {
                          result: serviceStatus(String(url).includes("relay2") ? 99 : 3),
                      }),
            })
        );
    });
    const rpc = { getDeployment: vi.fn().mockResolvedValue(deployment), getBroadcasters: pages };
    const protocol = await discover(rpc);
    const clients = await protocol.getBroadcasters({ tokenAddress });
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
                result: serviceStatus(String(url).includes("relay3") ? 3 : 4),
            })
        );
    });
    const protocol = await discover(rpc);
    expect(await protocol.getBroadcasters({ tokenAddress })).toHaveLength(2);
});
it("requires a configured registry", async () => {
    const protocol = new Protocol({ deployment: { chainId: 97n, protocol: deployment.protocol } });
    await expect(protocol.getBroadcasters({ tokenAddress })).rejects.toThrow(/registry/i);
});

it("cancels token discovery before contacting RPC and during service requests", async () => {
    const rpc = {
        getDeployment: async () => deployment,
        getBroadcasters: vi.fn().mockResolvedValue({ block, broadcasters: [entry(1)] }),
    };
    const protocol = await discover(rpc);
    const first = new AbortController();
    first.abort();
    await expect(
        protocol.getBroadcasters({ tokenAddress, signal: first.signal })
    ).rejects.toThrow();
    expect(rpc.getBroadcasters).not.toHaveBeenCalled();
    const active = new AbortController();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const req = JSON.parse(init!.body as string);
        expect(req.params).toEqual([{ tokenAddress }]);
        active.abort();
        expect(init!.signal!.aborted).toBe(true);
        return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: req.id, result: serviceStatus(1) })
        );
    });
    await expect(
        protocol.getBroadcasters({ tokenAddress, signal: active.signal })
    ).rejects.toThrow();
    expect(rpc.getBroadcasters.mock.calls[0]![0].signal).toBe(active.signal);
});

it("omits unsupported tokens and halted services without requesting a transaction quote", async () => {
    const rpc = {
        getDeployment: async () => deployment,
        getBroadcasters: vi
            .fn()
            .mockResolvedValue({ block, broadcasters: [entry(1), entry(2), entry(3)] }),
    };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const req = JSON.parse(init!.body as string);
        expect(req.method).toBe("broadcaster_getTokenSupport");
        expect(req.params).toEqual([{ tokenAddress }]);
        const n = String(url).includes("relay1") ? 1 : String(url).includes("relay2") ? 2 : 3;
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { ...serviceStatus(n), supported: n !== 1, submissionHalted: n === 2 },
            })
        );
    });
    const protocol = await discover(rpc);
    const clients = await protocol.getBroadcasters({ tokenAddress });
    expect(clients.map((client) => client.url)).toEqual([entry(3).endpoint]);
});

function successfulTokenSupport() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
        const req = JSON.parse(init!.body as string);
        const n = Number(String(url).match(/relay(\d+)/)![1]);
        return new Response(
            JSON.stringify({ jsonrpc: "2.0", id: req.id, result: serviceStatus(n) })
        );
    });
}

it("reuses initialized token discovery without RPC and protects its cached array", async () => {
    const rpc = { getBroadcasters: vi.fn().mockResolvedValue({ block, broadcasters: [entry(1)] }) };
    const fetcher = successfulTokenSupport();
    const protocol = await discover(rpc);
    expect(Object.isFrozen(protocol)).toBe(true);
    const initialized = await protocol.initializeBroadcasters({ tokenAddress });
    initialized.splice(0);
    const clients = await protocol.getBroadcasters({ tokenAddress });
    expect(clients.map((client) => client.url)).toEqual(["https://relay1.example/rpc"]);
    clients.splice(0);
    expect(await protocol.getBroadcasters({ tokenAddress })).toHaveLength(1);
    expect(rpc.getBroadcasters).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const aborted = AbortSignal.abort();
    await expect(protocol.getBroadcasters({ tokenAddress, signal: aborted })).rejects.toThrow();
});

it("keeps uninitialized discovery fresh and caches tokens independently", async () => {
    const rpc = { getBroadcasters: vi.fn().mockResolvedValue({ block, broadcasters: [entry(1)] }) };
    successfulTokenSupport();
    const protocol = await discover(rpc);
    await protocol.getBroadcasters({ tokenAddress });
    await protocol.getBroadcasters({ tokenAddress });
    expect(rpc.getBroadcasters).toHaveBeenCalledTimes(2);
    await protocol.initializeBroadcasters({ tokenAddress });
    await protocol.getBroadcasters({ tokenAddress: a(43) });
    expect(rpc.getBroadcasters).toHaveBeenCalledTimes(4);
});

it("refreshes initialized discovery and replaces the registered signer pins", async () => {
    const rpc = {
        getBroadcasters: vi
            .fn()
            .mockResolvedValueOnce({ block, broadcasters: [entry(1)] })
            .mockResolvedValueOnce({ block, broadcasters: [entry(2)] }),
    };
    successfulTokenSupport();
    const protocol = await discover(rpc);
    await protocol.initializeBroadcasters({ tokenAddress });
    const refreshed = await protocol.getBroadcasters({ tokenAddress, refresh: true });
    expect(refreshed[0]!.configuration.quoteSigner.toLowerCase()).toBe(a(12));
    expect((await protocol.getBroadcasters({ tokenAddress }))[0]!.url).toBe(
        "https://relay2.example/rpc"
    );
    expect(rpc.getBroadcasters).toHaveBeenCalledTimes(2);
});

it("invalidates previous success after a rejected refresh and permits retry", async () => {
    const rpc = {
        getBroadcasters: vi
            .fn()
            .mockResolvedValueOnce({ block, broadcasters: [entry(1)] })
            .mockRejectedValueOnce(new Error("registry unavailable"))
            .mockResolvedValue({ block, broadcasters: [entry(2)] }),
    };
    successfulTokenSupport();
    const protocol = await discover(rpc);
    await protocol.initializeBroadcasters({ tokenAddress });
    await expect(protocol.getBroadcasters({ tokenAddress, refresh: true })).rejects.toThrow(
        "registry unavailable"
    );
    expect((await protocol.getBroadcasters({ tokenAddress }))[0]!.url).toBe(
        "https://relay2.example/rpc"
    );
    await protocol.initializeBroadcasters({ tokenAddress });
    await protocol.getBroadcasters({ tokenAddress });
    expect(rpc.getBroadcasters).toHaveBeenCalledTimes(4);
});

it("does not retain empty initialization or a cancelled refresh", async () => {
    const rpc = {
        getBroadcasters: vi
            .fn()
            .mockResolvedValueOnce({ block, broadcasters: [] })
            .mockResolvedValue({ block, broadcasters: [entry(1)] }),
    };
    successfulTokenSupport();
    const protocol = await discover(rpc);
    expect(await protocol.initializeBroadcasters({ tokenAddress })).toEqual([]);
    expect(await protocol.getBroadcasters({ tokenAddress })).toHaveLength(1);
    await protocol.initializeBroadcasters({ tokenAddress });
    const controller = new AbortController();
    rpc.getBroadcasters.mockImplementationOnce(async () => {
        controller.abort();
        return { block, broadcasters: [entry(2)] };
    });
    await expect(
        protocol.getBroadcasters({ tokenAddress, refresh: true, signal: controller.signal })
    ).rejects.toThrow();
    expect((await protocol.getBroadcasters({ tokenAddress }))[0]!.url).toBe(
        "https://relay1.example/rpc"
    );
    expect(rpc.getBroadcasters).toHaveBeenCalledTimes(5);
});

it("does not publish an older initialization over a newer refresh", async () => {
    let resolveOld!: (value: {
        block: typeof block;
        broadcasters: ReturnType<typeof entry>[];
    }) => void;
    const rpc = {
        getBroadcasters: vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolveOld = resolve;
                    })
            )
            .mockResolvedValueOnce({ block, broadcasters: [entry(2)] }),
    };
    successfulTokenSupport();
    const protocol = await discover(rpc);
    const older = protocol.initializeBroadcasters({ tokenAddress });
    await protocol.getBroadcasters({ tokenAddress, refresh: true });
    resolveOld({ block, broadcasters: [entry(1)] });
    expect((await older)[0]!.url).toBe("https://relay1.example/rpc");
    expect((await protocol.getBroadcasters({ tokenAddress }))[0]!.url).toBe(
        "https://relay2.example/rpc"
    );
});

it("initializes through an overridden discovery policy", async () => {
    class CustomProtocol extends Protocol {
        override async getBroadcasters() {
            return [];
        }
    }
    const protocol = new CustomProtocol({ deployment });
    expect(await protocol.initializeBroadcasters({ tokenAddress })).toEqual([]);
});

it("bounds retained token snapshots and rediscovers an evicted token", async () => {
    const rpc = { getBroadcasters: vi.fn().mockResolvedValue({ block, broadcasters: [entry(1)] }) };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
        const req = JSON.parse(init!.body as string);
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: { ...serviceStatus(1), tokenAddress: req.params[0].tokenAddress },
            })
        );
    });
    const protocol = await discover(rpc);
    for (let n = 1; n <= 257; n++) await protocol.initializeBroadcasters({ tokenAddress: a(n) });
    await protocol.getBroadcasters({ tokenAddress: a(257) });
    expect(rpc.getBroadcasters).toHaveBeenCalledTimes(257);
    await protocol.getBroadcasters({ tokenAddress: a(1) });
    expect(rpc.getBroadcasters).toHaveBeenCalledTimes(258);
});
