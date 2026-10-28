import { expect, it } from "vitest";
import { selectNotes } from "./selection";
import type { StoredNote } from "./state";
const hash = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;
const record = (amount: bigint, index: number): StoredNote => ({
    commitment: hash(index + 1),
    treeId: 1n,
    leafIndex: index,
    blockNumber: 12n,
    blockHash: hash(12),
    spent: "unspent",
    note: {
        chainId: 31337n,
        protocolAddress: 1n,
        tokenAddress: 2n,
        walletIdentity: hash(3),
        amount,
        nonce: BigInt(index),
    },
});
it("chooses the fewest inputs with stable ties and excludes spent, unknown and reserved notes", () => {
    const notes = [record(20n, 0), record(100n, 2), record(100n, 1), record(80n, 3)];
    expect(selectNotes(notes, 90n, new Set()).map((note) => note.leafIndex)).toEqual([1]);
    expect(selectNotes(notes, 150n, new Set([hash(2)])).map((note) => note.leafIndex)).toEqual([
        2, 3,
    ]);
    expect(() =>
        selectNotes(
            [
                { ...notes[0]!, spent: "unknown" },
                { ...notes[1]!, spent: "spent" },
            ],
            1n,
            new Set()
        )
    ).toThrow(/available|verified/i);
    expect(selectNotes(notes, 0n, new Set())).toEqual([]);
});
