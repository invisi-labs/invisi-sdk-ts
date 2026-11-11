import { DeliveryAuthenticationError } from "./errors";
import { bytesToHex } from "@noble/hashes/utils";
import type { ReceivingKeys } from "../types";
import { ReceivingAddress } from "../address/receiving-address";
import { deliveryCodec, validateDeliveryCiphertext } from "./delivery-codec";
import { noteCommitment, creditCommitment } from "./validation";
import type { NoteBytes, NoteDecryptionContext, CreditStateDecryptionContext } from "./types";

export type DeliveryDecryptionResult = Uint8Array | null | { status: "authentication-failed" };
export interface DeliveryDetectionCandidate extends NoteDecryptionContext {
    role: "funds" | "owner" | "spender";
    clue: `0x${string}`;
    ciphertext: `0x${string}`;
}
export interface DeliveryDetectionBatch {
    ownerAddress: `0x${string}`;
    results: readonly ("candidate" | "not-recipient" | "unresolved")[];
}
/** App-owned decryption. Only null means nonrecipient; operational failures must reject. */
export interface DeliveryDecryptor {
    detect?(candidates: readonly DeliveryDetectionCandidate[]): Promise<DeliveryDetectionBatch>;
    decryptNote(
        envelope: NoteBytes,
        context: NoteDecryptionContext
    ): Promise<DeliveryDecryptionResult>;
    decryptCredit(
        envelope: NoteBytes,
        context: CreditStateDecryptionContext
    ): Promise<DeliveryDecryptionResult>;
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
export function authenticatedDecryptor(
    owner: `0x${string}`,
    decryptor: DeliveryDecryptor,
    expectedKeys?: ReceivingKeys
) {
    const ownerAddress = ReceivingAddress.fromIdentity(owner).ownerAddress;
    const receivingKeys = expectedKeys
        ? {
              viewingPublicKey: expectedKeys.viewingPublicKey.slice(),
              clueKey: expectedKeys.clueKey.slice(),
          }
        : undefined;
    return {
        ownerAddress,
        async detectCandidates(candidates: readonly DeliveryDetectionCandidate[]) {
            if (!decryptor.detect) return candidates.map(() => "candidate" as const);
            const result = await decryptor.detect(structuredClone(candidates));
            if (
                !result ||
                BigInt(result.ownerAddress) !== BigInt(ownerAddress) ||
                !Array.isArray(result.results) ||
                result.results.length !== candidates.length ||
                result.results.some(
                    (value) => !["candidate", "not-recipient", "unresolved"].includes(value)
                )
            )
                throw new DeliveryDecryptionError(
                    new Error("invalid detection batch or wrong account")
                );
            return [...result.results];
        },
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
                if (!(plaintext instanceof Uint8Array)) {
                    if (plaintext?.status === "authentication-failed")
                        throw new DeliveryAuthenticationError();
                    throw new Error("invalid decryption result");
                }
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
                if (cause instanceof DeliveryAuthenticationError) throw cause;
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
                if (!(plaintext instanceof Uint8Array)) {
                    if (plaintext?.status === "authentication-failed")
                        throw new DeliveryAuthenticationError();
                    throw new Error("invalid decryption result");
                }
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
                if (receivingKeys) {
                    const keys =
                        context.role === "owner"
                            ? state.ownerReceivingKeys
                            : state.spenderReceivingKeys;
                    if (
                        bytesToHex(keys.viewingPublicKey) !==
                        bytesToHex(receivingKeys.viewingPublicKey)
                    )
                        throw new Error("decrypted credit receiving key mismatch");
                }
                await creditCommitment(full, state.note);
                return state;
            } catch (cause) {
                if (cause instanceof DeliveryAuthenticationError) throw cause;
                throw new DeliveryDecryptionError(cause);
            }
        },
    };
}
