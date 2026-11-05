import type { ProtocolContext } from "../types";

/** Stored notes must belong to the chain and deployment used by an operation. */
export function assertNoteContext(note: ProtocolContext, context: ProtocolContext): void {
    if (note.chainId !== context.chainId || note.protocolAddress !== context.protocolAddress) {
        throw new Error("note context mismatch");
    }
}
