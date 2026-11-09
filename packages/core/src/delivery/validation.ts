import { computeNoteCommitment, computeNoteIdentity } from "../notes/commitment";
import { computeCreditCommitment, computeCreditSharedKeyHash } from "../credit/state";
import { assertNoteContext } from "../notes/noteContext";
import type { CreditState, Note } from "../types";
import { field, uint } from "./binary";
import { NoteEncryptionContext } from "./types";

export function validateContext(context: NoteEncryptionContext, tokenAddress: bigint): void {
    uint(context.chainId, 64, "chainId");
    uint(context.protocolAddress, 160, "protocolAddress");
    uint(tokenAddress, 160, "tokenAddress");
    field(BigInt(context.outputCommitment), "outputCommitment");
}

function validateNote(note: Note): void {
    uint(note.amount, 128, "amount");
    if (note.amount === 0n) throw new Error("amount must be positive");
    field(note.nonce, "nonce");
    uint(BigInt(note.ownerAddress), 160, "ownerAddress");
    if (BigInt(note.ownerAddress) === 0n) throw new Error("owner address must be positive");
    uint(note.tokenAddress, 160, "tokenAddress");
}

export async function noteCommitment(context: NoteEncryptionContext, note: Note): Promise<void> {
    validateContext(context, note.tokenAddress);
    assertNoteContext(note, context);
    validateNote(note);
    const commitment = await computeNoteCommitment(
        context.chainId,
        await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
        note.tokenAddress,
        note.amount
    );
    if (BigInt(commitment) !== BigInt(context.outputCommitment))
        throw new Error("output commitment mismatch");
}

export async function creditCommitment(
    context: NoteEncryptionContext,
    note: CreditState
): Promise<void> {
    validateContext(context, note.tokenAddress);
    assertNoteContext(note, context);
    const commitment = await computeCreditCommitment(note);
    if (BigInt(commitment) !== BigInt(context.outputCommitment))
        throw new Error("credit commitment mismatch");
}
