import { expect, it, vi } from "vitest";
import { Wallet, computeNoteCommitment, computeNoteIdentity } from "@invisi-labs/primitives";
import { fixture } from "../../../../../test-support/operation-fixture";
import { testOutput } from "../../../../../test-support/test-output";
import { quoteClient } from "../../../../../test-support/broadcaster-fixture";
import { setup } from "../execution/ExplicitTransaction-fixtures";

it("reuses deployment code and pinned membership during quotation while retaining canonical fences", async () => {
    const h = await setup();
    const prepared = await h.invisi.prepareTransfer({
        wallet: Wallet.fromAddress(h.wallet.getAddress()),
        protocol: h.protocol,
        tokenAddress: h.context.tokenAddress,
        inputs: h.inputs,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const code = vi.spyOn(h.reader, "getCode"),
        membership = vi.spyOn(h.membership, "getMembership"),
        block = vi.spyOn(h.reader, "getBlock");
    const quoted = await quoteClient(h.context).quote(prepared, { maxFeeAmount: 10n });
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([30n, 60n]);
    expect(code).not.toHaveBeenCalled();
    expect(membership).not.toHaveBeenCalled();
    expect(block.mock.calls.length).toBeGreaterThanOrEqual(2);
});

it("refreshes the frame if fee funding selects an input absent from the original read set", async () => {
    const h = await fixture();
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 100n })],
    });
    const note = { ...h.note, amount: 50n, nonce: 124n };
    const commitment = await computeNoteCommitment(
        h.context.chainId,
        BigInt(h.context.protocolAddress),
        await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
        note.tokenAddress,
        note.amount
    );
    await h.tree.insert(BigInt(commitment));
    await h.store.transaction(h.scope, (state) => {
        state.notes[commitment] = { ...state.notes[h.leaf]!, note, commitment, leafIndex: 1 };
    });
    const word = (n: bigint) => ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;
    h.reader.getLatestBlockNumber = vi.fn(async () => 13n);
    h.reader.getBlock = async (number) => ({
        number,
        hash: word(number),
        parentHash: word(number - 1n),
        timestamp: 2000000000n + number - 12n,
    });
    const membership = h.membership.getMembership;
    h.membership.getMembership = async (context, input, block) => ({
        ...(await membership(context, input, block)),
        block,
    });
    const quoted = await quoteClient(h.context).quote(prepared, { maxFeeAmount: 10n });
    expect(quoted.preview().inputs).toBe(2);
    expect(quoted.preview().outputs.map((o) => o.amount)).toEqual([100n, 40n]);
    expect(h.reader.getLatestBlockNumber).toHaveBeenCalled();
});

it("deduplicates concurrent immutable reads but never retains a failed read", async () => {
    const { PreparationReads } = await import("./preparation-reads");
    const h = await fixture(),
        read = vi.spyOn(h.reader, "getCode");
    const reads = new PreparationReads(h.reader, h.membership),
        reader = reads.reader();
    await Promise.all([
        reader.getCode(h.context.protocolAddress),
        reader.getCode(h.context.protocolAddress),
    ]);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(Error("offline"));
    await expect(reader.getCode(h.context.tokenAddress)).rejects.toThrow("offline");
    await expect(reader.getCode(h.context.tokenAddress)).resolves.toBe("0x6000");
    expect(read).toHaveBeenCalledTimes(3);
});

it("expires a quotation snapshot and keeps chain identity checks live", async () => {
    const { PreparationReads } = await import("./preparation-reads");
    const h = await fixture(),
        head = vi.spyOn(h.reader, "getLatestBlockNumber");
    const clock = vi.spyOn(performance, "now").mockReturnValue(0);
    try {
        const reads = new PreparationReads(h.reader, h.membership);
        await reads.reader().getLatestBlockNumber();
        await reads.reader(true).getLatestBlockNumber();
        expect(head).toHaveBeenCalledTimes(1);
        clock.mockReturnValue(30001);
        await reads.reader(true).getLatestBlockNumber();
        expect(head).toHaveBeenCalledTimes(2);
        await reads.reader().getChainId();
        h.reader.getChainId = async () => 1n;
        expect(await reads.reader(true).getChainId()).toBe(1n);
    } finally {
        clock.mockRestore();
    }
});

it("limits independent preparation work and preserves result order", async () => {
    const { mapPreparation } = await import("./parallel");
    let active = 0,
        peak = 0;
    const results = await mapPreparation(
        Array.from({ length: 12 }, (_, i) => i),
        async (value) => {
            peak = Math.max(peak, ++active);
            await new Promise((resolve) => setTimeout(resolve, value % 3));
            active--;
            return value;
        }
    );
    expect(peak).toBe(4);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i));
});

it("owns cached public responses instead of retaining provider-owned arrays", async () => {
    const { PreparationReads } = await import("./preparation-reads");
    const h = await fixture(),
        states = [false];
    h.reader.isSpent = async () => states;
    const reads = new PreparationReads(h.reader),
        block = await h.reader.getBlock(12n);
    const result = await reads.reader().isSpent(h.context, [h.leaf], block);
    states[0] = true;
    expect(result).toEqual([false]);
    expect(await reads.reader().isSpent(h.context, [h.leaf], block)).toEqual([false]);
});
