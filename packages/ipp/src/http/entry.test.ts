import { expect, it } from "vitest";
import { IppClient, paymentRequiredResponse } from "../index";
import { checkout, session, sessionUrl, token } from "../testing/fixtures";
it("continues a merchant 402 through the same neutral session entry without an implicit payment", async () => {
    let calls = 0;
    const response = paymentRequiredResponse(session(), checkout());
    const client = await IppClient.fromPaymentRequired(response, {
        fetch: async (url, init) => {
            calls++;
            expect(String(url)).toBe(sessionUrl);
            expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${token}`);
            return new Response(JSON.stringify(session()), {
                headers: { "content-type": "application/json" },
            });
        },
    });
    expect(calls).toBe(0);
    expect((await client.readSession()).sessionId).toBe("ses_test");
    expect(calls).toBe(1);
});
it("rejects conflicting 402 entry links", async () => {
    const response = paymentRequiredResponse(session(), checkout());
    response.headers.append("Link", `<https://evil.example/read>; rel="ipp-session"`);
    await expect(IppClient.fromPaymentRequired(response)).rejects.toThrow();
});
