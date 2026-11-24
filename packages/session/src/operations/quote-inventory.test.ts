import { expect, it, vi } from "vitest";
import { BroadcasterClient } from "@invisi-labs/sdk";
import { fixture } from "../../../../test-support/operation-fixture";
import { quoteClient } from "../../../../test-support/broadcaster-fixture";

it("uses only prepared inputs across fee iterations", async () => {
    const h = await fixture();
    const operation = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 70n },
    });
    let estimates = 0;
    const client = quoteClient(h.context, () => (++estimates === 1 ? 10n : 13n));
    const read = vi.spyOn(h.store, "readSnapshot");
    const quoted = await client.quote(operation, { maxFeeAmount: 20n });
    expect(estimates).toBeGreaterThanOrEqual(3);
    expect(read).not.toHaveBeenCalled();
    expect(quoted.preview().feeAmount).toBe(13n);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(operation.id);
    await quoted.abandon();
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBeUndefined();
});

it("rejects a concurrent spend when committing a quote from retained inventory", async () => {
    const h = await fixture();
    const operation = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 70n },
    });
    const base = quoteClient(h.context);
    const client = new BroadcasterClient(base.configuration, async (request, options) => {
        const result = await base.transport(request, options);
        if (request.method === "broadcaster_getQuote")
            await h.store.transaction(h.scope, (state) => {
                state.notes[h.leaf]!.spent = "spent";
            });
        return result;
    });
    await expect(client.quote(operation, { maxFeeAmount: 20n })).rejects.toThrow(/unavailable/);
    expect((await h.store.readSnapshot(h.scope)).operations[operation.id]!.status).toBe("prepared");
});
