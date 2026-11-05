import { computeNoteCommitment, computeNoteIdentity } from "../notes/commitment";
import { computeCreditCommitment, computeCreditSharedKeyHash } from "../notes/creditCommitment";
import { assertNoteContext } from "../notes/noteContext";
import type { CreditNote, Note } from "../types";
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

function validateCredit(note: CreditNote): void {
    uint(note.amount, 126, "amount");
    uint(note.expiry, 64, "expiry");
    uint(note.tokenAddress, 160, "tokenAddress");
    uint(BigInt(note.spenderWalletIdentity), 160, "spenderWalletIdentity");
    uint(BigInt(note.ownerWalletIdentity), 160, "ownerWalletIdentity");
    uint(note.spenderPayout, 160, "spenderPayout");
    uint(note.ownerPayout, 160, "ownerPayout");
    field(note.nonce, "nonce");
    field(note.creditSharedKey, "creditSharedKey");
    if (
        BigInt(note.spenderWalletIdentity) === 0n ||
        BigInt(note.ownerWalletIdentity) === 0n ||
        note.spenderPayout === 0n ||
        note.ownerPayout === 0n ||
        note.amount === 0n ||
        note.expiry === 0n ||
        note.creditSharedKey === 0n
    )
        throw new Error("Credit roles, payouts, amount, expiry and shared key must be positive");
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
    note: CreditNote
): Promise<void> {
    validateContext(context, note.tokenAddress);
    assertNoteContext(note, context);
    validateCredit(note);
    const commitment = await computeCreditCommitment(
        context.chainId,
        note.spenderWalletIdentity,
        note.ownerWalletIdentity,
        note.spenderPayout,
        note.ownerPayout,
        note.tokenAddress,
        note.amount,
        note.nonce,
        note.expiry,
        await computeCreditSharedKeyHash(note.creditSharedKey),
        note
    );
    if (BigInt(commitment) !== BigInt(context.outputCommitment))
        throw new Error("credit commitment mismatch");
}
