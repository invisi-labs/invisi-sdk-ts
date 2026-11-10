import { bytesToHex } from "@noble/hashes/utils";
import type { Wallet } from "../wallet/wallet-object";
import { deliveryCodec, validateDeliveryCiphertext } from "./delivery-codec";
import { noteCommitment, creditCommitment } from "./validation";
import type { NoteBytes, NoteDecryptionContext, CreditStateDecryptionContext } from "./types";

/** App-owned decryption. Only null means nonrecipient; operational failures must reject. */
export interface DeliveryDecryptor {
    decryptNote(envelope: NoteBytes, context: NoteDecryptionContext): Promise<Uint8Array | null>;
    decryptCredit(
        envelope: NoteBytes,
        context: CreditStateDecryptionContext
    ): Promise<Uint8Array | null>;
}

/** Keeps App failures and invalid plaintext distinct from unrelated local scan candidates. */
export class DeliveryDecryptionError extends Error {
    constructor(cause: unknown) {
        super(cause instanceof Error ? cause.message : "delivery decryption failed", { cause });
        this.name = "DeliveryDecryptionError";
    }
}

function checkedPlaintext(
    plaintext: Uint8Array,
    codec: { minimum: number; maximum: number }
): Uint8Array {
    if (!(plaintext instanceof Uint8Array)) throw new Error("invalid decrypted plaintext");
    if (plaintext.length + 78 < codec.minimum || plaintext.length + 78 > codec.maximum)
        throw new Error("invalid plaintext length");
    return plaintext.slice();
}

/** Bind untrusted App plaintext to the requested wallet, deployment, token and commitment. */
export function authenticatedDecryptor(wallet: Wallet, decryptor: DeliveryDecryptor) {
    const ownerAddress = wallet.ownerAddress;
    return {
        ownerAddress,
        async decryptNote(
            envelope: NoteBytes,
            context: Omit<NoteDecryptionContext, "ownerAddress">
        ) {
            context = { ...context };
            try {
                const bytes = validateDeliveryCiphertext(envelope, "funds");
                const full = { ...context, ownerAddress };
                const plaintext = await decryptor.decryptNote(bytes.slice(), { ...full });
                if (plaintext === null) return null;
                const codec = deliveryCodec(bytes[0]!);
                if (codec.kind !== "funds") throw new Error("unexpected envelope kind");
                const note = codec.decode(checkedPlaintext(plaintext, codec), full);
                if (
                    BigInt(note.ownerAddress) !== BigInt(ownerAddress) ||
                    note.tokenAddress !== context.tokenAddress
                )
                    throw new Error("decrypted note context mismatch");
                await noteCommitment(full, note);
                return note;
            } catch (cause) {
                throw new DeliveryDecryptionError(cause);
            }
        },
        async decryptCredit(
            envelope: NoteBytes,
            context: Omit<CreditStateDecryptionContext, "ownerAddress">
        ) {
            context = { ...context };
            try {
                const bytes = validateDeliveryCiphertext(envelope, "credit");
                const full = { ...context, ownerAddress };
                const plaintext = await decryptor.decryptCredit(bytes.slice(), { ...full });
                if (plaintext === null) return null;
                const codec = deliveryCodec(bytes[0]!);
                if (codec.kind !== "credit") throw new Error("unexpected envelope kind");
                const state = codec.decode(checkedPlaintext(plaintext, codec), full);
                const identity =
                    context.role === "owner"
                        ? state.note.ownerWalletIdentity
                        : state.note.spenderWalletIdentity;
                if (
                    BigInt(identity) !== BigInt(ownerAddress) ||
                    state.note.tokenAddress !== context.tokenAddress
                )
                    throw new Error("decrypted credit context mismatch");
                if (wallet.getReceivingAddress().kind === "long") {
                    const keys =
                        context.role === "owner"
                            ? state.ownerReceivingKeys
                            : state.spenderReceivingKeys;
                    if (bytesToHex(keys.viewingPublicKey) !== bytesToHex(wallet.viewingPublicKey))
                        throw new Error("decrypted credit receiving key mismatch");
                }
                await creditCommitment(full, state.note);
                return state;
            } catch (cause) {
                throw new DeliveryDecryptionError(cause);
            }
        },
    };
}
