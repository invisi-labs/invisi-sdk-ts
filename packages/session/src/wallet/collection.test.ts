import { expect, it } from "vitest";
import { fixture } from "../../../../test-support/operation-fixture";

it("imports authenticated openings without advancing discovery and preserves spent reservations", async () => {
    const h = await fixture();
    const input = { note: h.note, commitment: h.leaf, treeId: 1n, leafIndex: 0 };
    await h.store.transaction(h.scope, (s) => {
        s.notes[h.leaf]!.spent = "spent";
        s.operations.uncertain = { id: "uncertain", status: "uncertain", inputs: [h.leaf] };
        s.reservations[h.leaf] = "uncertain";
    });
    await h.session.importNotes([input]);
    const state = await h.store.readSnapshot(h.scope);
    expect(state.notes[h.leaf]!.spent).toBe("spent");
    expect(state.reservations[h.leaf]).toBe("uncertain");
    expect(state.discoveryThrough).toBeUndefined();
    expect(state.observedThrough?.number).toBe(12n);
});
it("rejects forged openings and membership without storing them", async () => {
    const h = await fixture();
    await h.store.transaction(h.scope, (s) => {
        delete s.notes[h.leaf];
    });
    const input = { note: h.note, commitment: h.leaf, treeId: 1n, leafIndex: 0 };
    await expect(
        h.session.importNotes([{ ...input, note: { ...h.note, amount: 99n } }])
    ).rejects.toThrow(/commitment/);
    await expect(h.session.importNotes([{ ...input, leafIndex: 1 }])).rejects.toThrow();
    expect(Object.keys((await h.store.readSnapshot(h.scope)).notes)).toHaveLength(0);
    await h.session.importNotes([input]);
    expect((await h.store.readSnapshot(h.scope)).notes[h.leaf]!.spent).toBe("unspent");
});
it("collects exactly selected notes into the full withdrawal without outputs or funding", async () => {
    const h = await fixture();
    const operation = await h.session.prepareCollection({
        tokenAddress: h.context.tokenAddress,
        recipient: h.wallet.ownerAddress,
        commitments: [h.leaf],
        deadline: 2000000100n,
    });
    expect(operation.preview().withdrawalAmount).toBe(100n);
    expect(operation.preview().outputs).toEqual([]);
    expect(operation.preview().inputs).toBe(1);
    expect((await h.store.readSnapshot(h.scope)).reservations[h.leaf]).toBe(operation.id);
    await expect(
        h.session.prepareCollection({
            tokenAddress: h.context.tokenAddress,
            recipient: h.wallet.ownerAddress,
            commitments: [h.leaf],
        })
    ).rejects.toThrow(/unavailable/);
});
it("rejects duplicate, foreign-owner and stale concurrent imports atomically", async () => {
    const h = await fixture(),
        input = { note: h.note, commitment: h.leaf, treeId: 1n, leafIndex: 0 };
    await expect(h.session.importNotes([input, input])).rejects.toThrow(/duplicate/);
    await expect(
        h.session.importNotes([{ ...input, note: { ...h.note, ownerAddress: h.bob.ownerAddress } }])
    ).rejects.toThrow(/owner/);
    const membership = h.membership.getMembership;
    h.membership.getMembership = async (...args) => {
        const proof = await membership(...args);
        await h.store.transaction(h.scope, (s) => {
            s.recoveryBoundary = 1n;
        });
        return proof;
    };
    await expect(h.session.importNotes([input])).rejects.toThrow(/changed/);
    expect((await h.store.readSnapshot(h.scope)).notes[h.leaf]!.checkedThrough).toBeUndefined();
});
it("reconciles imported membership with its older canonical creation receipt", async () => {
    const { mergeReceiptRecords } = await import("../sync/receipts");
    const h = await fixture();
    await h.store.transaction(h.scope, (s) => {
        delete s.notes[h.leaf];
    });
    await h.session.importNotes([{ note: h.note, commitment: h.leaf, treeId: 1n, leafIndex: 0 }]);
    const creation = {
        note: h.note,
        commitment: h.leaf,
        treeId: 1n,
        leafIndex: 0,
        blockNumber: 5n,
        blockHash: ("0x" + "05".repeat(32)) as `0x${string}`,
        transactionHash: ("0x" + "06".repeat(32)) as `0x${string}`,
        spent: "unknown" as const,
    };
    await h.store.transaction(h.scope, (s) =>
        mergeReceiptRecords(s, {
            notes: [creation],
            credits: [],
            checkpoint: { number: 12n, hash: s.observedThrough!.hash },
        })
    );
    const state = await h.store.readSnapshot(h.scope);
    expect(state.notes[h.leaf]!.blockNumber).toBe(5n);
    expect(state.notes[h.leaf]!.transactionHash).toBe(creation.transactionHash);
    expect(state.notes[h.leaf]!.spent).toBe("unspent");
    expect(state.notes[h.leaf]!.checkedThrough?.number).toBe(12n);
});
it("never adds an available larger note outside the explicit collection selection", async () => {
    const { computeNoteIdentity, computeNoteCommitment } = await import("@invisi-labs/primitives");
    const h = await fixture(),
        note = { ...h.note, nonce: 124n, amount: 7n };
    const commitment = await computeNoteCommitment(
        note.chainId,
        note.protocolAddress,
        await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
        note.tokenAddress,
        note.amount
    );
    await h.tree.insert(BigInt(commitment));
    await h.store.transaction(h.scope, (s) => {
        s.notes[commitment] = {
            note,
            commitment,
            treeId: 1n,
            leafIndex: 1,
            blockNumber: 12n,
            blockHash: s.observedThrough!.hash,
            spent: "unspent",
        };
    });
    const op = await h.session.prepareCollection({
        tokenAddress: h.context.tokenAddress,
        recipient: h.wallet.ownerAddress,
        commitments: [commitment],
    });
    expect(op.preview().withdrawalAmount).toBe(7n);
    expect(op.preview().outputs).toEqual([]);
    expect((await h.store.readSnapshot(h.scope)).reservations).toEqual({ [commitment]: op.id });
});
