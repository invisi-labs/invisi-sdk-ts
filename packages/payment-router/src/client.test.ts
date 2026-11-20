import { describe, expect, it } from "vitest";
import { PaymentRouterClient, UniswapV3Adapter, ZeroExAdapter } from "./index";
import {
    A,
    chain,
    corePayment,
    deployment,
    apiQuote,
    quoteOptions,
    routerInterface,
} from "./testing";
function fixture() {
    const h = chain(),
        client = new PaymentRouterClient({ deployment, provider: h.provider });
    const v3 = new UniswapV3Adapter({
        provider: h.provider,
        quoterAddress: A.quoter,
        routes: [{ tokens: [A.weth, A.token], fees: [3000] }],
    });
    const zero = new ZeroExAdapter({ transport: async () => apiQuote() });
    return { ...h, client, v3, zero };
}
describe("atomic payment construction", () => {
    it("wraps the real core tuple in V3 calldata and simulates the outer call", async () => {
        const h = fixture(),
            quote = await h.client.quote(h.v3, quoteOptions);
        const call = await h.client.buildPaymentTransaction({
            payment: corePayment(),
            quote,
            refundRecipient: A.player,
        });
        const decoded = routerInterface.parseTransaction(call)!;
        expect(decoded.name).toBe("pay");
        expect(decoded.args[0]).toBe("0x1234");
        expect(decoded.args[1].funding.payer).toBe(A.router);
        expect(decoded.args[1].funding.amount).toBe(10n);
        expect(call.to).toBe(A.router);
        expect(call.value).toBe(61n);
        const result = await h.client.simulatePayment(call, { from: A.player });
        expect(result).toEqual({ gasEstimate: 123456n, ethSpent: 60n, ethRefunded: 1n });
        const outer = h.state.calls.filter((c) => c.value !== undefined).at(-1)!;
        expect(outer.to).toBe(A.router);
        expect(outer.value).toBe(61n);
        expect(outer.from?.toLowerCase()).toBe(A.player);
    });
    it("builds 0x payment calldata with a freshly checked registered target", async () => {
        const h = fixture(),
            quote = await h.client.quote(h.zero, quoteOptions);
        const call = await h.client.buildPaymentTransaction({
            payment: corePayment(),
            quote,
            refundRecipient: A.player,
        });
        expect(routerInterface.parseTransaction(call)!.name).toBe("payWithZeroEx");
        expect(call.value).toBe(100n);
        h.state.settler = A.dex;
        await expect(
            h.client.buildPaymentTransaction({
                payment: corePayment(),
                quote,
                refundRecipient: A.player,
            })
        ).rejects.toThrow(/Settler|target/);
    });
    it("rejects payer, asset, amount and core mismatches rather than changing a proved statement", async () => {
        const h = fixture(),
            quote = await h.client.quote(h.v3, quoteOptions);
        await expect(
            h.client.buildPaymentTransaction({
                payment: corePayment(A.player),
                quote,
                refundRecipient: A.player,
            })
        ).rejects.toThrow(/payer/);
        await expect(
            h.client.buildPaymentTransaction({
                payment: corePayment(A.router, 11n),
                quote,
                refundRecipient: A.player,
            })
        ).rejects.toThrow(/amount/);
        await expect(
            h.client.buildPaymentTransaction({
                payment: { ...corePayment(), to: A.dex },
                quote,
                refundRecipient: A.player,
            })
        ).rejects.toThrow(/core|deployment/);
    });
    it("rejects expired quotes, wrong chain, changed deployment and simulation failures", async () => {
        const h = fixture(),
            quote = await h.client.quote(h.v3, quoteOptions);
        h.state.now = 1101;
        await expect(
            h.client.buildPaymentTransaction({
                payment: corePayment(),
                quote,
                refundRecipient: A.player,
            })
        ).rejects.toThrow(/expir/);
        h.state.now = 1000;
        h.state.chainId = 1n;
        await expect(h.client.quote(h.v3, quoteOptions)).rejects.toThrow(/chain/);
        h.state.chainId = 31337n;
        h.state.core = A.dex;
        await expect(h.client.quote(h.v3, quoteOptions)).rejects.toThrow(/core|deployment/);
        h.state.core = A.core;
        const call = await h.client.buildPaymentTransaction({
            payment: corePayment(),
            quote,
            refundRecipient: A.player,
        });
        h.state.failCall = true;
        await expect(h.client.simulatePayment(call, { from: A.player })).rejects.toThrow(
            /reverted/
        );
    });
    it("permits refreshing an expired quote without altering core calldata", async () => {
        const h = fixture(),
            payment = corePayment();
        await h.client.quote(h.v3, quoteOptions);
        h.state.now = 1110;
        const fresh = await h.client.quote(h.v3, { ...quoteOptions, deadline: 1200n });
        const call = await h.client.buildPaymentTransaction({
            payment,
            quote: fresh,
            refundRecipient: A.player,
        });
        expect(routerInterface.parseTransaction(call)!.args[0]).toBe("0x1234");
        expect(payment.data).toBe(corePayment().data);
    });
});

it("rejects quotes that expire or lose their registered Settler while transport is pending", async () => {
    for (const change of ["time", "registry"]) {
        const h = fixture();
        const slow = new ZeroExAdapter({
            transport: async () => {
                if (change === "time") h.state.now = 1101;
                else h.state.settler = A.dex;
                return apiQuote();
            },
        });
        await expect(h.client.quote(slow, quoteOptions)).rejects.toThrow(/expired|Settler|target/);
    }
});
