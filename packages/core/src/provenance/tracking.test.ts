import { it, expect } from "vitest";
import { ProvenanceClient, word, type TrustContext } from "./index";
it("requests deployment-scoped tracking,terminates bounded waits and rejects unknown/stale/untrusted responses", async () => {
    for (const status of ["recognized", "expired", "superseded", "stale_generation", "unknown"]) {
        let calls = 0;
        const trust: TrustContext = {
            chainId: "1",
            protocolAddress: "2",
            chainGeneration: "3",
            providerId: "4",
            manifestSha256: "a".repeat(64),
            signingKeys: { [word(5)]: new Uint8Array(32) },
        };
        const transport = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            calls++;
            const q = JSON.parse(String(init?.body));
            expect(q.method).toBe("provenance_getTracking");
            expect(q.params).toEqual([
                {
                    trackingId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                },
            ]);
            return new Response(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: q.id,
                    result: {
                        scope: { chainId: "1", protocolAddress: "2" },
                        chainGeneration: "3",
                        providerId: "4",
                        signingKeyId: "5",
                        manifestSha256: trust.manifestSha256,
                        tracking: {
                            id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            status,
                            expiresAt: "1",
                            operationDigest: word(9),
                            ...(status === "recognized"
                                ? {
                                      matched: {
                                          txHash: word(1),
                                          blockHash: word(2),
                                          operationIndex: "0",
                                      },
                                  }
                                : {}),
                        },
                    },
                })
            );
        }) as typeof fetch;
        const c = new ProvenanceClient("https://example.test", trust, transport);
        if (["unknown", "stale_generation"].includes(status))
            await expect(
                c.waitTracking("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
                    intervalMs: 1,
                    timeoutMs: 10,
                })
            ).rejects.toThrow();
        else
            expect(
                (
                    await c.waitTracking("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
                        intervalMs: 1,
                        timeoutMs: 10,
                    })
                ).tracking.status
            ).toBe(status);
        expect(calls).toBe(1);
    }
});
import { validateTracking, preflightTracking } from "./tracking";
it("checks expiry encoding and matched identity without expiring lagging-chain tasks by wall clock", () => {
    const id = "a".repeat(48),
        base = { id, status: "pending_confirmation", expiresAt: "1", operationDigest: word(9) };
    expect(validateTracking(base).status).toBe("pending_confirmation");
    expect(() => validateTracking({ ...base, status: "pending_source" })).toThrow("locator");
    expect(() => validateTracking({ ...base, expiresAt: "01" })).toThrow();
    expect(() => validateTracking({ ...base, expiresAt: "0" })).toThrow();
    const member = {
        operationIndex: "1",
        operationDigest: word(9),
        broadcastDecision: "allow",
        tracking: base,
    };
    expect(
        preflightTracking(
            {
                scope: { chainId: "1", protocolAddress: "2" },
                broadcastDecision: "allow",
                operations: [
                    { ...member, operationIndex: "0", tracking: { ...base, id: "b".repeat(48) } },
                    member,
                ],
            },
            "1",
            word(9)
        ).id
    ).toBe(id);
    expect(() =>
        preflightTracking(
            {
                scope: { chainId: "1", protocolAddress: "2" },
                ...member,
            },
            "1",
            word(8)
        )
    ).toThrow("allowed");
});

it("rejects contradictory allowed preflight acknowledgements with terminal tracking", () => {
    for (const status of ["expired", "superseded"]) {
        const result = {
            scope: { chainId: "1", protocolAddress: "2" },
            broadcastDecision: "allow",
            operationDigest: word(9),
            tracking: { id: "a".repeat(48), status, expiresAt: "1", operationDigest: word(9) },
        };
        expect(() => preflightTracking(result, "0", word(9))).toThrow(
            "no longer permits broadcast"
        );
    }
});
