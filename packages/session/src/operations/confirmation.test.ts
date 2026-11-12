import { expect, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { WalletSession } from "../wallet/WalletSession";
it("observes associated native finality without reconciling inventory or reservations", async () => {
    const h = await fixture();
    const session = new WalletSession(sessionOptions(h.options));
    const prepared = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [],
        withdrawal: { to: h.bob.ownerAddress, amount: 100n },
    });
    expect(await prepared.getConfirmation()).toEqual({
        level: "pending",
        status: "available",
        block: null,
    });
    const hash = `0x${"ab".repeat(32)}` as const;
    await h.store.transaction(h.scope, (state) => {
        state.operations[prepared.id]!.transactionHash = hash;
    });
    h.reader.getReceipt = async () => ({
        transactionHash: hash,
        block: await h.reader.getBlock(12n),
        status: "success",
        logs: [],
    });
    const before = await h.store.readSnapshot(h.scope);
    expect((await prepared.getConfirmation()).level).toBe("finalized");
    expect(await h.store.readSnapshot(h.scope)).toEqual(before);
});
