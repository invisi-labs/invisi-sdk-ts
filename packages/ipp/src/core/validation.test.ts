import { describe, expect, it } from "vitest";
import * as ipp from "../index";
import { checkout, origin, receipt, request, session, sessionUrl } from "../testing/fixtures";

it("validates both modes and keeps the independently timed Request intact", () => {
    for (const mode of ["payment", "credit"] as const) {
        expect(ipp.parsePaymentSession(session(mode), origin).mode).toBe(mode);
        const parsed = ipp.parsePaymentRequest(request(mode), origin);
        expect(parsed.expiresAt).toBe("2026-11-17T08:20:00Z");
        expect(
            ipp.assertRequestMatchesSession(parsed, ipp.parsePaymentSession(session(mode), origin))
        ).toBeUndefined();
    }
});
it("accepts the latest flattened receipt and expired abnormal sessions", () => {
    const s = {
        ...session(),
        status: "succeeded",
        activeRequestId: "req_test",
        links: { ...session().links, request: { href: `${origin}/read`, method: "GET" } },
        receipt: receipt(),
        evidenceStatus: "confirmed",
    };
    expect(ipp.parsePaymentSession(s, origin).receipt).toEqual(receipt());
    expect(
        ipp.parsePaymentSession(
            {
                ...session(),
                status: "failed",
                failureReason: "expired",
                exceptionSummary: { count: 1, unresolvedCount: 1 },
            },
            origin
        ).status
    ).toBe("failed");
    expect(() =>
        ipp.parsePaymentSession({ ...s, receipt: { ...receipt(), receiptId: "old" } }, origin)
    ).toThrow();
    expect(() => ipp.parsePaymentSession({ ...s, receipt: null }, origin)).toThrow();
});
it("does not mutate caller messages and rejects extra business fields", () => {
    const input = session();
    const parsed = ipp.parsePaymentSession(input, origin);
    parsed.merchant.name = "Another store";
    expect(input.merchant.name).toBe("Example Store");
    expect(() => ipp.parsePaymentRequest({ ...request(), requestHash: "extra" }, origin)).toThrow();
});
describe("strict wire parsing", () => {
    it.each(['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"outer":{"x":1,"x":2}}', '{"x":"\\ud800"}'])(
        "rejects ambiguous JSON %s",
        (text) => expect(() => ipp.parseIppJson(text)).toThrow()
    );
    it("allows the same key in unrelated objects and harmless punctuation in strings", () => {
        expect(ipp.parseIppJson('{"a":{"x":"a,}:"},"b":{"x":2}}')).toEqual({
            a: { x: "a,}:" },
            b: { x: 2 },
        });
    });
});

it.each([
    "http://connect.invisipay.fi/read",
    "https://evil.example/read",
    `${origin}/read#secret`,
    `${origin}/read?token=secret`,
    "https://user:pass@connect.invisipay.fi/read",
    "https://CONNECT.invisipay.fi/read",
    `${origin}:443/read`,
])("rejects unsafe operation URLs %s", (href) => {
    expect(() =>
        ipp.parsePaymentSession(
            { ...session(), links: { ...session().links, confirm: { href, method: "POST" } } },
            origin
        )
    ).toThrow();
});
it("rejects noncanonical timestamps, field keys, unsupported methods and mismatched selected terms", () => {
    const r = request("credit");
    expect(() =>
        ipp.parsePaymentRequest(
            { ...r, credit: { ...r.credit, creditSharedKey: `0x${"ff".repeat(32)}` } },
            origin
        )
    ).toThrow();
    expect(() =>
        ipp.parsePaymentRequest({ ...r, expiresAt: "2026-11-17T08:20:00.000Z" }, origin)
    ).toThrow();
    expect(() => ipp.parsePaymentRequest({ ...r, method: "other" }, origin)).toThrow();
    const changed = ipp.parsePaymentRequest(
        { ...request(), payment: { ...request().payment, amount: "2" } },
        origin
    );
    expect(() =>
        ipp.assertRequestMatchesSession(changed, ipp.parsePaymentSession(session(), origin))
    ).toThrow();
});
it("validates a checkout and extracts its exact one-time decoded session entry", () => {
    expect(ipp.parseCheckout(checkout()).sessionUrl).toBe(sessionUrl);
    expect(ipp.parseCheckoutEntry(checkout().checkoutUrl)).toEqual({
        sessionUrl,
        token: "EXAMPLE_SESSION_TOKEN",
    });
    expect(() => ipp.parseCheckout({ ...checkout(), sessionUrl: `${origin}/different` })).toThrow();
    expect(() => ipp.parseCheckoutEntry(`${checkout().checkoutUrl}&token=again`)).toThrow();
});
