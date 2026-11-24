import { describe, expect, it, vi } from "vitest";
import { TypedDataEncoder } from "ethers";
import vector from "./testdata/fee-lock-vector.json";
import { verifyBroadcasterFeeLock, broadcasterFeeLockTypes } from "./fee-lock";
import { broadcasterQuoteDomain, BroadcasterClient } from "./broadcaster";
const trust = { ...vector.trust, chainId: BigInt(vector.trust.chainId) };
describe("fee lock", () => {
    it("matches the common digest and authenticates the frozen tariff", () => {
        expect(
            TypedDataEncoder.hash(
                broadcasterQuoteDomain(trust),
                broadcasterFeeLockTypes,
                vector.lock
            )
        ).toBe(vector.digest);
        expect(() =>
            verifyBroadcasterFeeLock(
                vector,
                trust,
                vector.lock.token,
                vector.lock.feeRecipient,
                1900000000
            )
        ).not.toThrow();
    });
    it("rejects tampering, expiry and cross-domain replay", () => {
        expect(() =>
            verifyBroadcasterFeeLock(
                { ...vector, lock: { ...vector.lock, gasPrice: "1" } },
                trust,
                vector.lock.token,
                vector.lock.feeRecipient,
                1900000000
            )
        ).toThrow();
        expect(() =>
            verifyBroadcasterFeeLock(
                vector,
                trust,
                vector.lock.token,
                vector.lock.feeRecipient,
                2000000000
            )
        ).toThrow();
        expect(() =>
            verifyBroadcasterFeeLock(
                vector,
                { ...trust, chainId: 97n },
                vector.lock.token,
                vector.lock.feeRecipient,
                1900000000
            )
        ).toThrow();
    });
});

it("negotiates optional capability and sends the same ticket with both pricing calls", async () => {
    const { BroadcasterClient } = await import("./broadcaster");
    let advertised = true;
    let locks = 0;
    const seen: unknown[] = [];
    const client = new BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: trust.signer,
            feeRecipient: vector.lock.feeRecipient,
        },
        async (request) => {
            const params = (request.params as any[])?.[0];
            let result: unknown;
            if (request.method === "broadcaster_getStatus")
                result = {
                    apiVersion: "v1",
                    protocolVersion: "1",
                    chainId: vector.trust.chainId,
                    protocol: trust.protocol,
                    sender: trust.signer,
                    feeRecipient: vector.lock.feeRecipient,
                    submissionHalted: false,
                    provenance: { enabled: false },
                    ...(advertised
                        ? {
                              feeLock: {
                                  version: "1",
                                  model: vector.lock.model,
                                  core: true,
                                  router: false,
                              },
                          }
                        : {}),
                };
            else if (request.method === "broadcaster_lockFee") {
                locks++;
                result = { lock: vector.lock, signature: vector.signature };
            } else {
                seen.push(params.feeLock);
                result =
                    request.method === "broadcaster_getQuote"
                        ? vector.quote
                        : {
                              feeRecipient: vector.lock.feeRecipient,
                              feeAmount: "2",
                              maxGas: "100000",
                          };
            }
            return { jsonrpc: "2.0", id: request.id, result };
        }
    );
    const feeLock = await client.lockFee(vector.data, trust);
    expect(feeLock).toBeDefined();
    if (!feeLock) throw Error("missing ticket");
    await client.estimateQuote({ data: vector.data, feeLock });
    await client.getQuote({ data: vector.data, feeLock }, trust);
    expect(seen).toEqual([feeLock, feeLock]);
    advertised = false;
    expect(await client.lockFee(vector.data, trust)).toEqual(feeLock);
    expect(locks).toBe(1);
});

it("primes capabilities from authenticated token support and reuses only verified tickets", async () => {
    const { BroadcasterClient } = await import("./broadcaster");
    const methods: string[] = [];
    const client = new BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: trust.signer,
            feeRecipient: vector.lock.feeRecipient,
        },
        async (request) => {
            methods.push(request.method);
            const result =
                request.method === "broadcaster_lockFee"
                    ? { lock: vector.lock, signature: vector.signature }
                    : {
                          apiVersion: "v1",
                          protocolVersion: "1",
                          chainId: vector.trust.chainId,
                          protocol: trust.protocol,
                          sender: trust.signer,
                          feeRecipient: vector.lock.feeRecipient,
                          submissionHalted: false,
                          provenance: { enabled: false },
                          tokenAddress: vector.lock.token,
                          supported: true,
                          feeLock: {
                              version: "1",
                              model: vector.lock.model,
                              core: true,
                              router: false,
                          },
                      };
            return { jsonrpc: "2.0", id: request.id, result };
        }
    );
    expect(await client.supportsToken(vector.lock.token, trust)).toBe(true);
    const tickets = await Promise.all([
        client.lockFee(vector.data, trust),
        client.lockFee(vector.data, trust),
    ]);
    expect(tickets[0]).toEqual(tickets[1]);
    expect(tickets[0]).not.toBe(tickets[1]);
    tickets[0]!.lock.gasPrice = "1";
    expect((await client.lockFee(vector.data, trust))!.lock.gasPrice).toBe(vector.lock.gasPrice);
    expect(methods).toEqual(["broadcaster_getTokenSupport", "broadcaster_lockFee"]);
});

function cacheHarness(options: { advertised?: boolean; status?: Record<string, unknown> } = {}) {
    const methods: string[] = [];
    let rejectEstimate = false;
    const transport: import("./broadcaster").BroadcasterTransport = async (request) => {
        methods.push(request.method);
        if (request.method === "broadcaster_estimateQuote" && rejectEstimate)
            return {
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32042, message: "FEE_LOCK_GAS_EXCEEDED" },
            };
        const result =
            request.method === "broadcaster_lockFee"
                ? { lock: vector.lock, signature: vector.signature }
                : request.method === "broadcaster_estimateQuote"
                  ? { feeRecipient: vector.lock.feeRecipient, feeAmount: "2", maxGas: "100000" }
                  : {
                        apiVersion: "v1",
                        protocolVersion: "1",
                        chainId: vector.trust.chainId,
                        protocol: trust.protocol,
                        sender: trust.signer,
                        feeRecipient: vector.lock.feeRecipient,
                        submissionHalted: false,
                        provenance: { enabled: false },
                        tokenAddress: vector.lock.token,
                        supported: true,
                        ...(options.advertised === false
                            ? {}
                            : {
                                  feeLock: {
                                      version: "1",
                                      model: vector.lock.model,
                                      core: true,
                                      router: false,
                                  },
                              }),
                        ...options.status,
                    };
        return { jsonrpc: "2.0", id: request.id, result };
    };
    const client = new BroadcasterClient(
        {
            endpoint: "https://relay.test",
            quoteSigner: trust.signer,
            feeRecipient: vector.lock.feeRecipient,
        },
        transport
    );
    return {
        client,
        methods,
        transport,
        reject: () => {
            rejectEstimate = true;
        },
    };
}

it("caches legacy absence while retaining the final dynamic service policy read", async () => {
    const { client, methods } = cacheHarness({ advertised: false });
    await client.prepareCapabilities(trust);
    expect(await client.lockFee(vector.data, trust)).toBeUndefined();
    expect(await client.lockFee(vector.data, trust)).toBeUndefined();
    await client.submissionRequirements({ ...vector.quote, context: trust } as any);
    expect(methods).toEqual(["broadcaster_getStatus", "broadcaster_getStatus"]);
});

it("evicts a gas-rejected ticket and refetches without re-reading capabilities", async () => {
    const { client, methods, reject } = cacheHarness();
    const feeLock = await client.lockFee(vector.data, trust);
    if (!feeLock) throw Error("missing ticket");
    reject();
    await expect(client.estimateQuote({ data: vector.data, feeLock })).rejects.toThrow(
        "FEE_LOCK_GAS_EXCEEDED"
    );
    await client.lockFee(vector.data, trust);
    expect(methods).toEqual([
        "broadcaster_getStatus",
        "broadcaster_lockFee",
        "broadcaster_estimateQuote",
        "broadcaster_lockFee",
    ]);
});

it("never reuses a ticket after exact expiry", async () => {
    const { client, methods } = cacheHarness();
    const now = vi.spyOn(Date, "now").mockReturnValue((Number(vector.lock.deadline) - 1) * 1000);
    try {
        await client.lockFee(vector.data, trust);
        now.mockReturnValue(Number(vector.lock.deadline) * 1000);
        await expect(client.lockFee(vector.data, trust)).rejects.toThrow("FEE_LOCK_EXPIRED");
        expect(methods.filter((m) => m === "broadcaster_lockFee")).toHaveLength(2);
    } finally {
        now.mockRestore();
    }
});

it("invalidates capability and ticket authority when transport changes", async () => {
    const { client, methods, transport } = cacheHarness();
    await client.lockFee(vector.data, trust);
    (client as any).transport = (request: any) => transport(request);
    await client.lockFee(vector.data, trust);
    expect(methods).toEqual([
        "broadcaster_getStatus",
        "broadcaster_lockFee",
        "broadcaster_getStatus",
        "broadcaster_lockFee",
    ]);
});

it.each([
    { protocol: "0x4444444444444444444444444444444444444444" },
    { sender: "0x4444444444444444444444444444444444444444" },
    { feeLock: { version: "1", model: "unsupported", core: true, router: false } },
    { feeLock: { version: "1", model: vector.lock.model, core: true } },
])(
    "rejects unauthenticated or unsupported capabilities before a ticket request: %j",
    async (status) => {
        const { client, methods } = cacheHarness({ status });
        await expect(client.lockFee(vector.data, trust)).rejects.toThrow();
        expect(methods).toEqual(["broadcaster_getStatus"]);
    }
);

it("bounds capability freshness and fails closed after an advertised lock error", async () => {
    const { client, transport, methods } = cacheHarness();
    await client.prepareCapabilities(trust);
    (client as any).transport = async (request: Parameters<typeof transport>[0]) => {
        if (request.method === "broadcaster_lockFee") {
            methods.push(request.method);
            return {
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32601, message: "missing advertised lock" },
            };
        }
        return transport(request);
    };
    await expect(client.lockFee(vector.data, trust)).rejects.toThrow("missing advertised lock");
    await expect(client.lockFee(vector.data, trust)).rejects.toThrow("missing advertised lock");
    expect(methods).toEqual([
        "broadcaster_getStatus",
        "broadcaster_getStatus",
        "broadcaster_lockFee",
        "broadcaster_lockFee",
    ]);
});

it("refreshes capability at the cache lifetime boundary", async () => {
    const { client, methods } = cacheHarness({ advertised: false });
    const now = vi.spyOn(Date, "now").mockReturnValue(1900000000000);
    try {
        await client.prepareCapabilities(trust);
        now.mockReturnValue(1900000299999);
        await client.lockFee(vector.data, trust);
        expect(methods).toHaveLength(1);
        now.mockReturnValue(1900000300000);
        await client.lockFee(vector.data, trust);
        expect(methods).toEqual(["broadcaster_getStatus", "broadcaster_getStatus"]);
    } finally {
        now.mockRestore();
    }
});

it("preserves a replacement ticket when an older concurrent pricing failure arrives", async () => {
    const { client, transport, methods } = cacheHarness();
    let finishOld!: (value: unknown) => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
        started = resolve;
    });
    let estimates = 0;
    (client as any).transport = async (request: Parameters<typeof transport>[0]) => {
        if (request.method === "broadcaster_estimateQuote") {
            estimates++;
            const error = {
                jsonrpc: "2.0",
                id: request.id,
                error: { code: -32042, message: "FEE_LOCK_GAS_EXCEEDED" },
            };
            if (estimates === 1) {
                started();
                return new Promise((resolve) => {
                    finishOld = () => resolve(error);
                });
            }
            return error;
        }
        return transport(request);
    };
    const ticketA = (await client.lockFee(vector.data, trust))!;
    const delayed = client
        .estimateQuote({ data: vector.data, feeLock: ticketA })
        .catch((error) => error);
    await start;
    await expect(client.estimateQuote({ data: vector.data, feeLock: ticketA })).rejects.toThrow(
        "FEE_LOCK_GAS_EXCEEDED"
    );
    const ticketB = await client.lockFee(vector.data, trust);
    finishOld(undefined);
    await delayed;
    expect(await client.lockFee(vector.data, trust)).toEqual(ticketB);
    expect(methods.filter((method) => method === "broadcaster_lockFee")).toHaveLength(2);
});

it.each(["call", "supportsToken", "prepareCapabilities"])(
    "invalidates capabilities when the %s authority method changes",
    async (method) => {
        const { client, methods } = cacheHarness({ advertised: false });
        await client.prepareCapabilities(trust);
        const original = (client as any)[method].bind(client);
        (client as any)[method] = (...args: unknown[]) => original(...args);
        expect(await client.lockFee(vector.data, trust)).toBeUndefined();
        expect(methods).toEqual(["broadcaster_getStatus", "broadcaster_getStatus"]);
    }
);

it("uses the newer token-support capability when an older status read finishes last", async () => {
    const { client, transport, methods } = cacheHarness();
    let finishStatus!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
        started = resolve;
    });
    (client as any).transport = async (request: Parameters<typeof transport>[0]) => {
        if (request.method === "broadcaster_getStatus") {
            const response = (await transport(request)) as any;
            delete response.result.feeLock;
            started();
            return new Promise((resolve) => {
                finishStatus = () => resolve(response);
            });
        }
        return transport(request);
    };
    const pending = client.lockFee(vector.data, trust);
    await start;
    expect(await client.supportsToken(vector.lock.token, trust)).toBe(true);
    finishStatus();
    expect(await pending).toBeDefined();
    expect(methods).toEqual([
        "broadcaster_getStatus",
        "broadcaster_getTokenSupport",
        "broadcaster_lockFee",
    ]);
});

it("fences a pending ticket when newer token support refreshes its capability generation", async () => {
    const { client, transport, methods } = cacheHarness();
    let finishTicket!: () => void;
    let started!: () => void;
    const start = new Promise<void>((resolve) => {
        started = resolve;
    });
    let locks = 0;
    (client as any).transport = async (request: Parameters<typeof transport>[0]) => {
        const response = await transport(request);
        if (request.method === "broadcaster_lockFee" && ++locks === 1) {
            started();
            return new Promise((resolve) => {
                finishTicket = () => resolve(response);
            });
        }
        return response;
    };
    const pending = client.lockFee(vector.data, trust);
    await start;
    await client.supportsToken(vector.lock.token, trust);
    await client.lockFee(vector.data, trust);
    finishTicket();
    await pending;
    await client.lockFee(vector.data, trust);
    expect(methods.filter((method) => method === "broadcaster_lockFee")).toHaveLength(2);
});
