import { expect, it } from "vitest";
import {
    IppClient,
    IppMerchantClient,
    parseCheckoutEntry,
    parsePaymentSession,
    parsePaymentRequest,
} from "../index";
import { checkout, origin, request, session, sessionUrl, token } from "../testing/fixtures";
it("rejects a confirm response for an option other than the one actually selected", async () => {
    const s = session();
    s.options.push({ ...s.options[0]!, id: "another" });
    const results = [s, { ...request(), optionId: "another" }];
    const client = new IppClient({
        sessionUrl,
        token,
        fetch: async () =>
            new Response(JSON.stringify(results.shift()), {
                status: 200,
                headers: { "content-type": "application/json", Location: `${origin}/read` },
            }),
    });
    await client.readSession();
    await expect(client.confirm("base_usdc", "key")).rejects.toThrow();
});
it("recovers a creation replay after the confirm window has expired", async () => {
    const old = "2020-01-01T00:00:00Z";
    const client = new IppMerchantClient({
        createUrl: `${origin}/create`,
        token,
        fetch: async () =>
            new Response(JSON.stringify({ ...checkout(), expiresAt: old }), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
    });
    expect(
        (
            await client.createCheckout(
                { ippVersion: 1, mode: "payment", options: session().options, expiresAt: old },
                "original-key"
            )
        ).expiresAt
    ).toBe(old);
});
it("rejects malformed percent encoding in checkout credentials", () => {
    expect(() =>
        parseCheckoutEntry(checkout().checkoutUrl.replace("EXAMPLE_SESSION_TOKEN", "%ZZ"))
    ).toThrow();
});
it("rejects inconsistent receipt mode data and a Request preceding its Session", () => {
    const r = request();
    expect(() =>
        parsePaymentSession({ ...session(), status: "requires_action" }, origin)
    ).toThrow();
    expect(() =>
        parsePaymentRequest({ ...r, createdAt: "2026-11-17T09:00:00Z" }, origin)
    ).toThrow();
});
