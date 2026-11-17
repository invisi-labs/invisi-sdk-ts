import { afterEach, expect, it, vi } from "vitest";
import { IppClient, createCheckoutUrl, parseCheckout, parseCheckoutEntry } from "../index";
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
afterEach(() => {
    vi.useRealTimers();
});
it("rejects session credentials in checkout queries or paths before building a browser entry", () => {
    const fragment = checkout().checkoutUrl.split("#")[1]!;
    for (const page of [
        `https://dapp.example/checkout?token=${token}`,
        `https://dapp.example/${token}`,
    ]) {
        expect(() => createCheckoutUrl(sessionUrl, token, page)).toThrow();
        expect(() => parseCheckoutEntry(`${page}#${fragment}`)).toThrow();
        expect(() =>
            parseCheckout({ ...checkout(), checkoutUrl: `${page}#${fragment}` })
        ).toThrow();
    }
});
it("does not send a bearer hidden in an operation's otherwise non-sensitive path or query", async () => {
    let calls = 0;
    const client = new IppClient({
        sessionUrl,
        token,
        fetch: async () => {
            calls++;
            return new Response(
                JSON.stringify({
                    ...session(),
                    links: {
                        ...session().links,
                        confirm: { href: `${origin}/route?next=${token}`, method: "POST" },
                    },
                }),
                { headers: { "content-type": "application/json" } }
            );
        },
    });
    await expect(client.readSession()).rejects.toThrow();
    expect(calls).toBe(1);
});
it("honors Retry-After on successful pending-state polling", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const client = new IppClient({
        sessionUrl,
        token,
        fetch: async () => {
            calls++;
            const value =
                calls === 1
                    ? session()
                    : {
                          ...session(),
                          status: "succeeded",
                          activeRequestId: "req_test",
                          receipt: receipt(),
                          evidenceStatus: "confirmed",
                          links: {
                              ...session().links,
                              request: { href: `${origin}/read`, method: "GET" },
                          },
                      };
            return new Response(JSON.stringify(value), {
                headers: { "content-type": "application/json", "retry-after": "2" },
            });
        },
    });
    const pending = client.waitForResult({ intervalMs: 100, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).status).toBe("succeeded");
    expect(calls).toBe(2);
});
it("rejects malformed UTF-8 instead of replacing bytes in authenticated messages", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(session()));
    bytes[bytes.indexOf(69)] = 255;
    const client = new IppClient({
        sessionUrl,
        token,
        fetch: async () => new Response(bytes, { headers: { "content-type": "application/json" } }),
    });
    await expect(client.readSession()).rejects.toThrow();
});

it("rejects secrets in confirmation Location and later session links", async () => {
    for (const secret of [token, hash]) {
        let calls = 0;
        const client = new IppClient({
            sessionUrl,
            token,
            fetch: async () => {
                calls++;
                return new Response(
                    JSON.stringify(calls === 1 ? session("credit") : request("credit")),
                    {
                        status: calls === 1 ? 200 : 201,
                        headers: {
                            "content-type": "application/json",
                            location: `${origin}/read?r=${secret}`,
                        },
                    }
                );
            },
        });
        await expect(client.confirm("base_usdc", "confirm-key")).rejects.toThrow();
        expect(calls).toBe(2);
    }
    for (const link of ["confirm", "request"] as const) {
        let calls = 0;
        const client = new IppClient({
            sessionUrl,
            token,
            fetch: async () => {
                calls++;
                const updated = {
                    ...session("credit"),
                    activeRequestId: "req_test",
                    status: "requires_action",
                    links: {
                        confirm: { href: `${origin}/confirm`, method: "POST" },
                        request: { href: `${origin}/read`, method: "GET" },
                    },
                };
                updated.links[link].href += `?r=${hash}`;
                return new Response(
                    JSON.stringify(
                        calls === 1 ? session("credit") : calls === 2 ? request("credit") : updated
                    ),
                    {
                        status: calls === 2 ? 201 : 200,
                        headers: { "content-type": "application/json", location: `${origin}/read` },
                    }
                );
            },
        });
        await client.confirm("base_usdc", "confirm-key");
        await expect(client.readSession()).rejects.toThrow();
        expect(calls).toBe(3);
    }
});
it("binds a recovered successful receipt to the subsequently read request", async () => {
    let calls = 0;
    const client = new IppClient({
        sessionUrl,
        token,
        fetch: async () => {
            calls++;
            return new Response(
                JSON.stringify(
                    calls === 1
                        ? {
                              ...session(),
                              status: "succeeded",
                              activeRequestId: "req_test",
                              receipt: receipt(),
                              evidenceStatus: "confirmed",
                              links: {
                                  ...session().links,
                                  request: { href: `${origin}/read`, method: "GET" },
                              },
                          }
                        : {
                              ...request(),
                              payment: {
                                  ...request().payment,
                                  protocolAddress: "0x4444444444444444444444444444444444444444",
                              },
                          }
                ),
                { headers: { "content-type": "application/json" } }
            );
        },
    });
    await client.readSession();
    await expect(client.readRequest()).rejects.toThrow();
});

it("screens cached recovery links when the request first reveals a credit key", async () => {
    let calls = 0;
    const client = new IppClient({
        sessionUrl,
        token,
        fetch: async () => {
            calls++;
            const pending = {
                ...session("credit"),
                status: "requires_action",
                activeRequestId: "req_test",
                links: {
                    ...session("credit").links,
                    request: { href: `${origin}/read?r=${hash}`, method: "GET" },
                },
            };
            return new Response(JSON.stringify(calls === 1 ? pending : request("credit")), {
                headers: { "content-type": "application/json" },
            });
        },
    });
    await client.readSession();
    await expect(client.readRequest()).rejects.toThrow();
    expect(calls).toBe(2);
});
