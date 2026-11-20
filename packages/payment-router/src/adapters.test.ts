import { expect, it } from "vitest";
import { UniswapV3Adapter, ZeroExAdapter, createZeroExQuoteFetcher } from "./index";
import { A, chain, deployment, quoteOptions, apiQuote, nativePayload } from "./testing";
function request() {
    return { ...quoteOptions, deployment, now: 1000n, blockNumber: 10, settlerAddress: A.settler };
}
it("rejects invalid standalone 0x deadlines and slippage before calling transport", async () => {
    let calls = 0;
    const adapter = new ZeroExAdapter({
        transport: async () => {
            calls++;
            return apiQuote();
        },
    });
    for (const changes of [
        { deadline: -1n },
        { deadline: 1n << 64n },
        { slippageBps: -1 },
        { slippageBps: 10001 },
        { slippageBps: 0.5 },
        { slippageBps: Number.NaN },
    ])
        await expect(adapter.quote({ ...request(), ...changes })).rejects.toThrow();
    expect(calls).toBe(0);
});
it("quotes V3 exact output with integer-rounded slippage and a strict user budget", async () => {
    const h = chain(),
        a = new UniswapV3Adapter({
            provider: h.provider,
            quoterAddress: A.quoter,
            routes: [{ tokens: [A.weth, A.token], fees: [3000] }],
        });
    expect(await a.quote(request())).toMatchObject({
        channel: "uniswap-v3",
        estimatedInput: 60n,
        maxInput: 61n,
        amountOut: 10n,
    });
    await expect(a.quote({ ...request(), maxInput: 60n })).rejects.toThrow(/budget|route/);
});
it("rejects 0x exact-buy metadata that disagrees with the on-chain statement", async () => {
    for (const response of [
        { ...apiQuote(), buyAmount: "11" },
        { ...apiQuote(), sellToken: A.weth },
        { ...apiQuote(), liquidityAvailable: false },
        { ...apiQuote(), transaction: { ...apiQuote().transaction, value: "99" } },
    ]) {
        await expect(
            new ZeroExAdapter({ transport: async () => response }).quote(request())
        ).rejects.toThrow();
    }
    const q = await new ZeroExAdapter({ transport: async () => apiQuote() }).quote(request());
    expect(q).toMatchObject({
        channel: "zeroex",
        amountOut: 10n,
        estimatedInput: 60n,
        maxInput: 100n,
    });
});
it("requests buyAmount with the Router as taker/recipient and reports HTTP errors without secrets", async () => {
    let sent: URL | undefined;
    const fetcher = createZeroExQuoteFetcher({
        apiKey: "test-secret",
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
            sent = new URL(String(input));
            expect(new Headers(init?.headers).get("0x-version")).toBe("v2");
            return new Response(JSON.stringify(apiQuote()), {
                status: 200,
                headers: { "Content-Type": "application/json" },
            });
        },
    });
    await new ZeroExAdapter({ transport: fetcher }).quote(request());
    expect(sent!.searchParams.get("buyAmount")).toBe("10");
    expect(sent!.searchParams.get("sellAmount")).toBeNull();
    expect(sent!.searchParams.get("taker")).toBe(A.router);
    expect(sent!.searchParams.get("recipient")).toBe(A.router);
    const failing = createZeroExQuoteFetcher({
        apiKey: "test-secret",
        fetch: async () => new Response("test-secret", { status: 401 }),
    });
    await expect(failing(request())).rejects.toThrow(/401/);
    await expect(failing(request())).rejects.not.toThrow(/test-secret/);
});

it("pins the direct V3 adapter budget before asynchronous provider reads", async () => {
    const h = chain();
    const adapter = new UniswapV3Adapter({
        provider: h.provider,
        quoterAddress: A.quoter,
        routes: [{ tokens: [A.weth, A.token], fees: [3000] }],
    });
    const input = { ...request(), maxInput: 60n };
    const pending = adapter.quote(input);
    input.maxInput = 1000n;
    await expect(pending).rejects.toThrow(/budget|route/);
});
it("does not let a 0x transport rewrite the authorized budget", async () => {
    const input = request();
    const adapter = new ZeroExAdapter({
        transport: async (received) => {
            received.maxInput = 1000n;
            return {
                ...apiQuote(),
                maxSellAmount: "1000",
                transaction: {
                    to: A.settler,
                    value: "1000",
                    data: nativePayload(1000n),
                },
            };
        },
    });
    await expect(adapter.quote(input)).rejects.toThrow(/budget/);
    expect(input.maxInput).toBe(quoteOptions.maxInput);
});
