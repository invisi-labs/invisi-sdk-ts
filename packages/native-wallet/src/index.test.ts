import { expect, it } from "vitest";
import { createNativeWalletClient } from "./index";
const request = (id: string) => ({
    version: 1 as const,
    id,
    ownerAddress: "0x1111111111111111111111111111111111111111" as const,
    method: "wallet.public" as const,
    params: {},
});
const response = (id: string) => ({
    ...request(id),
    params: undefined,
    result: {
        viewingPublicKey: "0x" + "11".repeat(33),
        spendingPublicKey: "0x" + "11".repeat(65),
        clueKey: "0x" + "11".repeat(32),
    },
});
it("validates whole batches before transport and skips empty batches", async () => {
    let calls = 0;
    const provider = createNativeWalletClient({
        executeWalletRequests: async () => {
            calls++;
            return "[]";
        },
    });
    expect(await provider.execute([])).toEqual([]);
    await expect(provider.execute([request("a"), request("a")])).rejects.toThrow(/duplicate/);
    await expect(
        provider.execute([
            request("a"),
            { ...request("b"), ownerAddress: "0x2222222222222222222222222222222222222222" },
        ])
    ).rejects.toThrow(/owners/);
    await expect(
        provider.execute(Array.from({ length: 1025 }, (_, i) => request(String(i))))
    ).rejects.toThrow(/batch/);
    expect(calls).toBe(0);
});
it("orders responses by id and preserves explicit per-item errors", async () => {
    const provider = createNativeWalletClient({
        executeWalletRequests: async (json) =>
            JSON.stringify(
                JSON.parse(json)
                    .reverse()
                    .map(({ params, ...item }: any) => ({
                        ...item,
                        error: { code: "WALLET_NOT_RECIPIENT" },
                    }))
            ),
    });
    expect((await provider.execute([request("a"), request("b")])).map((item) => item.id)).toEqual([
        "a",
        "b",
    ]);
    expect((await provider.execute([request("a")]))[0]).toHaveProperty(
        "error.code",
        "WALLET_NOT_RECIPIENT"
    );
});
it("rejects missing, duplicate, unknown, crossed, and ambiguous response envelopes", async () => {
    for (const values of [
        [],
        [response("a"), response("a")],
        [response("a"), response("c")],
        [{ ...response("a"), method: "wallet.detect" }, response("b")],
        [{ ...response("a"), error: { code: "WALLET_FAILURE" } }, response("b")],
    ]) {
        const provider = createNativeWalletClient({
            executeWalletRequests: async () => JSON.stringify(values),
        });
        await expect(provider.execute([request("a"), request("b")])).rejects.toThrow();
    }
});
it("rejects error detail fields and oversized encoded responses", async () => {
    for (const json of [
        JSON.stringify([
            {
                version: 1,
                id: "a",
                ownerAddress: request("a").ownerAddress,
                method: "wallet.public",
                error: { code: "WALLET_FAILURE", message: "secret" },
            },
        ]),
        " ".repeat(16 * 1024 * 1024 + 1),
    ]) {
        const provider = createNativeWalletClient({ executeWalletRequests: async () => json });
        await expect(provider.execute([request("a")])).rejects.toThrow();
    }
});

it("returns successful reordered members in request order", async () => {
    const provider = createNativeWalletClient({
        executeWalletRequests: async () => JSON.stringify([response("b"), response("a")]),
    });
    expect((await provider.execute([request("a"), request("b")])).map((item) => item.id)).toEqual([
        "a",
        "b",
    ]);
});
