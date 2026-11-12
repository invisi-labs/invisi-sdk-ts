import { it, expect, vi, afterEach } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { testOutput } from "../../../../test-support/test-output";
afterEach(() => {
    vi.restoreAllMocks();
});
it("estimates a prepared operation locally without proof, approval, export or state writes", async () => {
    const h = await fixture();
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 100n })],
    });
    const before = await h.store.readSnapshot(h.scope);
    const exportCall = vi
        .spyOn(Object.getPrototypeOf(prepared), "exportTransaction")
        .mockRejectedValue(Error("must not export"));
    const chainHead = vi
        .spyOn(h.reader, "getLatestBlockNumber")
        .mockRejectedValue(Error("must not query chain"));
    const write = vi.spyOn(h.store, "transaction").mockRejectedValue(Error("must not write"));
    const estimate = await prepared.estimateGas();
    expect(estimate).toMatchObject({
        source: "benchmark",
        available: true,
        gasUnits: expect.any(BigInt),
    });
    expect(prepared.status).toBe("prepared");
    expect("getGasReference" in prepared).toBe(false);
    expect(exportCall).not.toHaveBeenCalled();
    expect(chainHead).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
    expect(await h.store.readSnapshot(h.scope)).toEqual(before);
});

it("models a C1 withdrawal with a fee before signing", async () => {
    const h = await fixture();
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 98n },
        fee: { recipient: h.bob.ownerAddress, amount: 2n },
    });
    expect(prepared.estimateGas()).toMatchObject({
        source: "benchmark",
        available: true,
        gasUnits: expect.any(BigInt),
    });
});
it("matches C4 mixed funding without querying approval", async () => {
    const h = await fixture();
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: await Promise.all(
            [1n, 2n, 3n].map((nonce) =>
                testOutput(h, { to: h.bob.getAddress(), amount: 30n, nonce })
            )
        ),
        funding: { payer: h.wallet.ownerAddress, amount: 40n, authorization: "caller" },
        withdrawal: { to: h.bob.ownerAddress, amount: 30n },
        fee: { recipient: h.bob.ownerAddress, amount: 20n },
    });
    expect(prepared.estimateGas()).toMatchObject({
        source: "benchmark",
        available: true,
        gasUnits: 1855550n,
    });
});
it.each(["fee", "withdrawal"] as const)(
    "does not mislabel a C2 %s payout with change as a private-only path",
    async (kind) => {
        const h = await fixture();
        const prepared = await h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 70n })],
            ...(kind === "fee"
                ? { fee: { recipient: h.bob.ownerAddress, amount: 30n } }
                : { withdrawal: { to: h.bob.ownerAddress, amount: 30n } }),
        });
        const estimate = prepared.estimateGas();
        expect(estimate).toMatchObject({
            source: "benchmark",
            available: true,
        });
        if (estimate.available) expect(estimate.gasUnits).toBeGreaterThan(0n);
    }
);
