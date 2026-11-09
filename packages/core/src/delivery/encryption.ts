import type { CreditDeliveryState, CreditState, Note } from "../types";
import { deliveryCodec, deliveryHeader } from "./delivery-codec";
import { envelopeBytes, open, publicKey, seal, viewingPublicKey } from "./envelope";
import { normalizeCreditDeliveryState } from "./note-payload";
import {
    CreditStateDecryptionContext,
    CreditStateEncryptionContext,
    NoteBytes,
    NoteDecryptionContext,
    NoteEncryptionContext,
} from "./types";
import { creditCommitment, noteCommitment } from "./validation";

export { normalizeCreditDeliveryState } from "./note-payload";

function copyPayload(value: Uint8Array, codec: { minimum: number; maximum: number }): Uint8Array {
    if (!(value instanceof Uint8Array)) throw new Error("codec encode must return Uint8Array");
    if (value.length + 78 < codec.minimum || value.length + 78 > codec.maximum)
        throw new Error("invalid codec payload length");
    return Uint8Array.from(value);
}

/** SDK v1 funds envelope with a fixed financial prefix and opaque application bytes. */
export async function encryptPrivateTransferNote(
    viewingKey: NoteBytes,
    note: Note,
    context: NoteEncryptionContext
): Promise<Uint8Array> {
    const scopedNote = structuredClone(note),
        scopedContext = { ...context };
    const codec = deliveryCodec(deliveryHeader("funds"));
    if (codec.kind !== "funds") throw new Error("unexpected envelope kind");
    await noteCommitment(scopedContext, scopedNote);
    const plaintext = copyPayload(codec.encode(structuredClone(scopedNote)), codec);
    return seal(
        viewingKey,
        plaintext,
        scopedContext,
        scopedNote.tokenAddress,
        deliveryHeader("funds"),
        0
    );
}

/** Authenticates the context and output commitment before returning the ordinary note. */
async function readNote(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext,
    payloadKey = false
): Promise<Note & { payload: Uint8Array }> {
    const authenticatedContext = { ...context };
    const data = envelopeBytes(envelope, false);
    const headerByte = data[0]!;
    const plain = await open(key, data, authenticatedContext, headerByte, 0, payloadKey);
    try {
        const codec = deliveryCodec(headerByte);
        if (codec.kind !== "funds") throw new Error("unexpected envelope kind");
        const note = structuredClone(
            codec.decode(plain, Object.freeze({ ...authenticatedContext }))
        );

        if (BigInt(note.ownerAddress) !== BigInt(authenticatedContext.ownerAddress))
            throw new Error("recipient owner address mismatch");
        if (note.tokenAddress !== authenticatedContext.tokenAddress)
            throw new Error("note token context mismatch");
        await noteCommitment(authenticatedContext, note);
        return note;
    } finally {
        plain.fill(0);
    }
}

function creditRole(role: string): number {
    if (role !== "owner" && role !== "spender")
        throw new Error("Credit role must be owner or spender");
    return role === "owner" ? 1 : 2;
}

function matchCreditRecipient(
    state: CreditDeliveryState,
    role: "owner" | "spender",
    recipient: Uint8Array
): void {
    const keys = role === "owner" ? state.ownerReceivingKeys : state.spenderReceivingKeys;
    if (!keys.viewingPublicKey.every((value, index) => value === recipient[index]))
        throw new Error("recipient receiving key mismatch");
}

/** SDK v1 Credit envelope with a fixed recovery prefix and opaque application bytes. */
export async function encryptCreditState(
    viewingKey: NoteBytes,
    state: CreditDeliveryState,
    context: CreditStateEncryptionContext
): Promise<Uint8Array> {
    const scopedState = normalizeCreditDeliveryState(state),
        scopedNote = scopedState.note;
    const scopedContext = { ...context };
    const codec = deliveryCodec(deliveryHeader("credit"));
    if (codec.kind !== "credit") throw new Error("unexpected envelope kind");
    creditRole(scopedContext.role);
    matchCreditRecipient(scopedState, scopedContext.role, publicKey(viewingKey));
    await creditCommitment(scopedContext, scopedNote);
    const plaintext = copyPayload(codec.encode(structuredClone(scopedState)), codec);
    return seal(
        viewingKey,
        plaintext,
        scopedContext,
        scopedNote.tokenAddress,
        deliveryHeader("credit"),
        creditRole(scopedContext.role)
    );
}

/** Authenticates the complete Credit header, context and output commitment. */
async function readCredit(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditStateDecryptionContext,
    payloadKey = false
): Promise<CreditDeliveryState & { note: CreditState & { payload: Uint8Array } }> {
    const authenticatedContext = { ...context };
    const data = envelopeBytes(envelope, true);
    const plain = await open(
        key,
        data,
        authenticatedContext,
        data[0]!,
        creditRole(authenticatedContext.role),
        payloadKey
    );
    try {
        const codec = deliveryCodec(data[0]!);
        if (codec.kind !== "credit") throw new Error("unexpected envelope kind");
        const state = normalizeCreditDeliveryState(
            structuredClone(codec.decode(plain, Object.freeze({ ...authenticatedContext })))
        );
        const note = state.note;
        if (
            BigInt(
                authenticatedContext.role === "owner"
                    ? note.ownerWalletIdentity
                    : note.spenderWalletIdentity
            ) !== BigInt(authenticatedContext.ownerAddress)
        )
            throw new Error("recipient owner address mismatch");

        if (!payloadKey)
            matchCreditRecipient(state, authenticatedContext.role, viewingPublicKey(key));
        if (note.tokenAddress !== authenticatedContext.tokenAddress)
            throw new Error("Credit token context mismatch");
        await creditCommitment(authenticatedContext, note);
        return {
            ...state,
            note: { ...state.note, payload: Uint8Array.from(state.note.payload ?? []) },
        };
    } finally {
        plain.fill(0);
    }
}

/** Authenticated recipient decryption. Application payload bytes are never decoded here. */
export function decryptPrivateTransferNote(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext
): Promise<Note & { payload: Uint8Array }> {
    return readNote(key, envelope, context);
}

/** Authenticated Credit decryption, including role and historical receiving keys. */
export function decryptCreditState(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditStateDecryptionContext
): Promise<CreditDeliveryState & { note: CreditState & { payload: Uint8Array } }> {
    return readCredit(key, envelope, context);
}

// Internal disclosure primitives. Public callers use Disclosure or ViewingCapability.
export function decryptNotePayload(
    key: NoteBytes,
    envelope: NoteBytes,
    context: NoteDecryptionContext
): Promise<Note & { payload: Uint8Array }> {
    return readNote(key, envelope, context, true);
}

export function decryptCreditPayload(
    key: NoteBytes,
    envelope: NoteBytes,
    context: CreditStateDecryptionContext
): Promise<CreditDeliveryState & { note: CreditState & { payload: Uint8Array } }> {
    return readCredit(key, envelope, context, true);
}

export {
    CreditStateDecryptionContext,
    CreditStateEncryptionContext,
    NoteBytes,
    NoteDecryptionContext,
    NoteEncryptionContext,
} from "./types";

export { exportPayloadKey, viewingPublicKey } from "./envelope";
