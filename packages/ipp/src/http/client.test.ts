import { expect, it, vi } from "vitest";
import { IppClient, IppError, parsePaymentSession } from "../index";
import {
    checkout,
    hash,
    origin,
    receipt,
    request,
    session,
    sessionUrl,
    token,
} from "../testing/fixtures";
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json", ...headers },
    });
function transport(responses: Response[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher: typeof fetch = async (input, init = {}) => {
        calls.push({ url: String(input), init });
        const response = responses.shift();
        if (!response) throw Error("Unexpected fetch");
        return response;
    };
    return { calls, fetcher };
}
it("reads, confirms and resumes a selected request via server links without changing its deadline", async () => {
    const h = transport([
        json(session()),
        json(request(), 201, { Location: `${origin}/not/a/fixed/path` }),
        json(request()),
    ]);
    const client = IppClient.fromCheckout(checkout(), { fetch: h.fetcher });
    await client.readSession();
    const req = await client.confirm("base_usdc", "confirm-one");
    expect(req.expiresAt).toBe("2026-11-17T08:20:00Z");
    expect((await client.readRequest()).requestId).toBe("req_test");
    expect(h.calls.map((c) => c.url)).toEqual([
        sessionUrl,
        `${origin}/custom/confirm`,
        `${origin}/not/a/fixed/path`,
    ]);
    expect(h.calls[1]!.init.body).toBe('{"optionId":"base_usdc"}');
    for (const { init } of h.calls) {
        expect(new Headers(init.headers).get("authorization")).toBe(`Bearer ${token}`);
        expect(init.redirect).toBe("error");
        expect(init.credentials).toBe("omit");
    }
    expect(JSON.stringify(client)).not.toContain(token);
});
it("treats null and omitted session descriptions equivalently across reads", async () => {
    const { description: _description, ...omitted } = session();
    const withoutDescription = { ...omitted, description: null };
    const h = transport([json(withoutDescription), json(omitted), json(withoutDescription)]);
    const client = new IppClient({ sessionUrl, token, fetch: h.fetcher });
    for (let i = 0; i < 3; i++) {
        expect(await client.readSession()).toEqual(omitted);
    }
});
it("rejects cross-origin Location and unsafe links before sending credentials", async () => {
    const h = transport([
        json(session()),
        json(request(), 201, { Location: "https://evil.example/request" }),
    ]);
    const client = new IppClient({ sessionUrl, token, fetch: h.fetcher });
    await client.readSession();
    await expect(client.confirm("base_usdc", "same-key")).rejects.toBeInstanceOf(IppError);
    expect(h.calls).toHaveLength(2);
});
it("does not replace a frozen Request or another session when reading recovery state", async () => {
    const r = request();
    const h = transport([
        json(session()),
        json(r, 201, { Location: `${origin}/read` }),
        json({
            ...r,
            payment: {
                ...r.payment,
                recipient: { type: "identity", identity: `0x${"02".repeat(32)}` },
            },
        }),
    ]);
    const client = new IppClient({ sessionUrl, token, fetch: h.fetcher });
    await client.readSession();
    await client.confirm("base_usdc", "one");
    await expect(client.readRequest()).rejects.toThrow();
});
it("polls only the original session URL and never confirms or submits a payment", async () => {
    const s = {
        ...session(),
        status: "succeeded",
        activeRequestId: "req_test",
        links: { ...session().links, request: { href: `${origin}/read`, method: "GET" } },
        receipt: receipt(),
        evidenceStatus: "confirmed",
    };
    const h = transport([json(session()), json(s)]);
    const client = new IppClient({ sessionUrl, token, fetch: h.fetcher });
    expect((await client.waitForResult({ intervalMs: 1, timeoutMs: 500 })).status).toBe(
        "succeeded"
    );
    expect(h.calls.every((c) => c.url === sessionUrl && c.init.method === "GET")).toBe(true);
});
it("queries expired failures without losing anomalous receipt facts or proposing another payment", async () => {
    const failed = {
        ...session(),
        status: "failed",
        failureReason: "expired",
        exceptionSummary: { count: 1, unresolvedCount: 1 },
    };
    const h = transport([json(failed)]);
    expect(
        (await new IppClient({ sessionUrl, token, fetch: h.fetcher }).waitForResult())
            .exceptionSummary.count
    ).toBe(1);
    expect(h.calls).toHaveLength(1);
});
it("handles server errors without exposing server text, tokens or private request bodies", async () => {
    const h = transport([
        json(
            {
                ippVersion: 1,
                type: "error",
                error: { code: "unauthorized", message: token, retryable: false },
            },
            401
        ),
    ]);
    const client = new IppClient({ sessionUrl, token, fetch: h.fetcher });
    try {
        await client.readSession();
        throw Error("Expected failure");
    } catch (error) {
        expect(error).toBeInstanceOf(IppError);
        expect((error as IppError).status).toBe(401);
        expect(String(error)).not.toContain(token);
        expect(JSON.stringify(error)).not.toContain(token);
    }
});
it("requires explicit bounded waiting and supports abort", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    const client = new IppClient({ sessionUrl, token, fetch: fetcher });
    await expect(client.waitForResult({ signal: controller.signal })).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.waitForResult({ timeoutMs: 0 })).rejects.toThrow();
});
it("submits optional hints with the correct request binding but never calls settle", async () => {
    const h = transport([
        json(session()),
        json(request(), 201, { Location: `${origin}/read` }),
        json(
            {
                ippVersion: 1,
                type: "credential_acknowledgement",
                sessionId: "ses_test",
                requestId: "req_test",
                status: "accepted",
            },
            202
        ),
    ]);
    const client = new IppClient({ sessionUrl, token, fetch: h.fetcher });
    await client.readSession();
    await client.confirm("base_usdc", "one");
    await client.submitCredential({
        ippVersion: 1,
        type: "credential",
        mode: "payment",
        method: "invisi",
        sessionId: "ses_test",
        requestId: "req_test",
        proof: { type: "note", transactionHash: hash, commitment: hash },
    });
    expect(h.calls[2]!.url).toBe(`${origin}/custom/hints`);
});
it("rejects request or session transitions that rewrite terminal success", async () => {
    const s = {
        ...session(),
        status: "succeeded",
        activeRequestId: "req_test",
        receipt: receipt(),
        evidenceStatus: "confirmed",
        links: { ...session().links, request: { href: `${origin}/read`, method: "GET" } },
    };
    const h = transport([json(s), json(session())]);
    const client = new IppClient({ sessionUrl, token, fetch: h.fetcher });
    await client.readSession();
    await expect(client.readSession()).rejects.toThrow();
    expect(parsePaymentSession(s, origin).status).toBe("succeeded");
});
