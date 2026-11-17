import { expect, it } from "vitest";
import { IppMerchantClient, createCheckoutUrl, paymentRequiredResponse } from "../index";
import { checkout, origin, session, sessionUrl, token } from "../testing/fixtures";
it("creates a checkout at the configured merchant URL with explicit idempotency", async () => {
    let called = false;
    const expiresAt = "2035-01-01T00:00:00Z";
    const fetcher: typeof fetch = async (url, init) => {
        called = true;
        expect(String(url)).toBe(`${origin}/business/create`);
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer merchant_token");
        expect(new Headers(init?.headers).get("idempotency-key")).toBe("order-one");
        expect(init?.redirect).toBe("error");
        return new Response(JSON.stringify({ ...checkout(), expiresAt }), {
            status: 201,
            headers: { "content-type": "application/json" },
        });
    };
    const client = new IppMerchantClient({
        createUrl: `${origin}/business/create`,
        token: "merchant_token",
        fetch: fetcher,
    });
    expect(
        (
            await client.createCheckout(
                { ippVersion: 1, mode: "payment", options: session().options, expiresAt },
                "order-one"
            )
        ).expiresAt
    ).toBe(expiresAt);
    expect(called).toBe(true);
});
it("constructs a standard 402 without creating an order, broadcasting or redeeming", async () => {
    const response = paymentRequiredResponse(session(), checkout());
    expect(response.status).toBe(402);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("link")).toContain(`rel="ipp-session"`);
    expect(response.headers.get("link")).toContain(`rel="ipp-checkout"`);
    expect(await response.json()).toEqual(session());
});
it("uses the default neutral checkout and protects token delivery", () => {
    expect(createCheckoutUrl(sessionUrl, token)).toBe(checkout().checkoutUrl);
    expect(() => createCheckoutUrl(`${origin}/read?token=secret`, token)).toThrow();
    expect(() => createCheckoutUrl(sessionUrl, token, "http://checkout.example/")).toThrow();
});
it("rejects malformed create inputs before any merchant request", async () => {
    let calls = 0;
    const client = new IppMerchantClient({
        createUrl: `${origin}/business/create`,
        token,
        fetch: async () => {
            calls++;
            throw Error();
        },
    });
    await expect(
        client.createCheckout(
            { ippVersion: 1, mode: "payment", options: [], expiresAt: "2035-01-01T00:00:00Z" },
            "key"
        )
    ).rejects.toThrow();
    expect(calls).toBe(0);
});
it("accepts an authenticated business API handing off a distinct initial IPP service origin", async () => {
    const expiresAt = "2035-01-01T00:00:00Z";
    const client = new IppMerchantClient({
        createUrl: "https://business.example/create",
        token: "merchant_token",
        fetch: async () =>
            new Response(JSON.stringify({ ...checkout(), expiresAt }), {
                status: 201,
                headers: { "content-type": "application/json" },
            }),
    });
    expect(
        (
            await client.createCheckout(
                { ippVersion: 1, mode: "payment", options: session().options, expiresAt },
                "order-one"
            )
        ).sessionUrl
    ).toBe(sessionUrl);
});
