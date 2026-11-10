import type { ProtocolContext } from "../types";

export type NoteBytes = `0x${string}` | Uint8Array;

export interface NoteEncryptionContext extends ProtocolContext {
    outputCommitment: `0x${string}`;
}

export interface NoteDecryptionContext extends NoteEncryptionContext {
    tokenAddress: bigint;
    ownerAddress: `0x${string}`;
}

export interface CreditStateEncryptionContext extends NoteEncryptionContext {
    role: "owner" | "spender";
}

export interface CreditStateDecryptionContext extends NoteDecryptionContext {
    role: "owner" | "spender";
}
