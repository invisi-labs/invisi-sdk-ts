import { describe, expect, it } from "vitest";
import { computeNoteCommitment, computeNoteIdentity } from "../notes/commitment";
import { noteCommitment } from "./validation";
import type { Note } from "../types";

describe("Note Protocol domain", () => {
    it("rejects a leaf created for another Protocol even with the same opening", async () => {
        const note: Note = {
            chainId: 31337n,
            protocolAddress: 0x1234n,
            ownerAddress: "0x0000000000000000000000000000000000000001",
            tokenAddress: 0x5678n,
            amount: 70n,
            nonce: 123n,
        };
        const outputCommitment = await computeNoteCommitment(
            note.chainId,
            BigInt(note.protocolAddress),
            await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
            note.tokenAddress,
            note.amount
        );
        const other = { ...note, protocolAddress: 0x1235n };
        await expect(noteCommitment({ ...other, outputCommitment }, other)).rejects.toThrow(
            "output commitment mismatch"
        );
    });
});
