import { describe, expect, it, vi } from "vitest";
import { ProtocolRpcClient, ProtocolRpcError } from "./ProtocolRpcClient";

const chain = (chainId = "42161") => ({
    chainId,
    rpcPath: `/v1/chains/${chainId}`,
    protocolVersion: "1",
});
const response = (chains: unknown = [chain()]) => ({ apiVersion: "v1", chains });
const fetching = (value: unknown) => vi.fn(async () => new Response(JSON.stringify(value)));

describe("service chain discovery", () => {
    it("accepts a service URL directly", async () => {
        const fetch = fetching(response());
        const spy = vi.spyOn(globalThis, "fetch").mockImplementation(fetch);
        try {
            expect(await ProtocolRpcClient.getChains("https://example.org/v1")).toHaveLength(1);
            expect(fetch).toHaveBeenCalledWith("https://example.org/v1", expect.anything());
        } finally {
            spy.mockRestore();
        }
    });

    it("discovers without Chain RPC and returns immutable connectable endpoints", async () => {
        const fetch = fetching(response([chain(), chain("1")]));
        const chains = await ProtocolRpcClient.getChains({
            url: "https://example.org/rpc/v1/",
            fetch,
        });
        expect(chains).toEqual([
            {
                chainId: 42161n,
                protocolVersion: "1",
                rpcUrl: "https://example.org/rpc/v1/chains/42161",
            },
            { chainId: 1n, protocolVersion: "1", rpcUrl: "https://example.org/rpc/v1/chains/1" },
        ]);
        expect(Object.isFrozen(chains)).toBe(true);
        expect(Object.isFrozen(chains[0])).toBe(true);
        expect(fetch).toHaveBeenCalledWith(
            "https://example.org/rpc/v1/",
            expect.objectContaining({ method: "GET", redirect: "error" })
        );
    });

    it("distinguishes an empty service from failed discovery", async () => {
        await expect(
            ProtocolRpcClient.getChains({
                url: "https://example.org/v1",
                fetch: fetching(response([])),
            })
        ).resolves.toEqual([]);
        await expect(
            ProtocolRpcClient.getChains({
                url: "https://example.org/v1",
                fetch: async () => new Response("unavailable", { status: 503 }),
            })
        ).rejects.toMatchObject({ kind: "http", code: 503 });
    });

    it.each([
        { apiVersion: "unsupported", chains: [] },
        response(null),
        response({}),
        response([chain("0")]),
        response([chain("01")]),
        response([chain("18446744073709551616")]),
        response([{ ...chain(), chainId: 42161 }]),
        response([chain(), chain()]),
        response([{ ...chain(), protocolVersion: "2" }]),
        response([{ ...chain(), rpcPath: "https://other.example/v1/chains/42161" }]),
        response([{ ...chain(), rpcPath: "/v1/chains/1" }]),
    ])("rejects malformed service metadata and foreign routes %j", async (value) => {
        await expect(
            ProtocolRpcClient.getChains({ url: "https://example.org/v1", fetch: fetching(value) })
        ).rejects.toBeInstanceOf(ProtocolRpcError);
    });

    it("retains explicit authentication when connecting to a discovered chain", async () => {
        const calls: { url: string; init?: RequestInit }[] = [];
        const fetch: typeof globalThis.fetch = async (url, init) => {
            calls.push({ url: String(url), ...(init ? { init } : {}) });
            if (init?.method === "GET") return new Response(JSON.stringify(response()));
            const request = JSON.parse(init?.body as string);
            return new Response(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: request.id,
                    result: {
                        apiVersion: "v1",
                        protocolVersion: "1",
                        deployment: {
                            chainId: "42161",
                            protocol: {
                                address: "0x1111111111111111111111111111111111111111",
                                runtimeCodeHash: `0x${"11".repeat(32)}`,
                                fromBlock: 1,
                            },
                        },
                    },
                })
            );
        };
        const options = {
            url: "https://example.org/v1?access=opaque",
            token: "private-token",
            fetch,
        };
        const [selected] = await ProtocolRpcClient.getChains(options);
        expect(selected?.rpcUrl).toBe("https://example.org/v1/chains/42161?access=opaque");
        const reader = { getBlock: vi.fn(), isKnownRoot: vi.fn() };
        const rpc = new ProtocolRpcClient({ ...options, url: selected!.rpcUrl, reader });
        expect((await rpc.getDeployment(42161n)).chainId).toBe(42161n);
        expect(reader.getBlock).not.toHaveBeenCalled();
        expect(calls).toHaveLength(2);
        for (const call of calls)
            expect(call.init?.headers).toMatchObject({ Authorization: "Bearer private-token" });
    });

    it("supports cancellation without sending a discovery request", async () => {
        const controller = new AbortController();
        controller.abort();
        const fetch = fetching(response());
        await expect(
            ProtocolRpcClient.getChains(
                { url: "https://example.org/v1", fetch },
                { signal: controller.signal }
            )
        ).rejects.toMatchObject({ kind: "aborted" });
        expect(fetch).not.toHaveBeenCalled();
    });

    it("times out stalled discovery without exposing upstream secrets", async () => {
        vi.useFakeTimers();
        try {
            const fetch: typeof globalThis.fetch = async (_url, init) =>
                new Promise((_, reject) => {
                    init?.signal?.addEventListener(
                        "abort",
                        () => reject(new Error("upstream-secret")),
                        { once: true }
                    );
                });
            const request = ProtocolRpcClient.getChains({
                url: "https://example.org/v1?secret=private",
                token: "private-token",
                fetch,
                timeoutMs: 10,
            });
            const checked = expect(request).rejects.toMatchObject({
                kind: "timeout",
                message: "RPC request timed out",
            });
            await vi.advanceTimersByTimeAsync(10);
            await checked;
        } finally {
            vi.useRealTimers();
        }
    });

    it("rejects a chain URL before sending discovery to the wrong endpoint", async () => {
        const fetch = fetching(response());
        await expect(
            ProtocolRpcClient.getChains({ url: "https://example.org/v1/chains/42161", fetch })
        ).rejects.toThrow(/service \/v1 URL/);
        expect(fetch).not.toHaveBeenCalled();
    });
});
