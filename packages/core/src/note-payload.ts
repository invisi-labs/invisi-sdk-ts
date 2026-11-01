import { secp256k1 } from "@noble/curves/secp256k1";
import { validateClueKey } from "./fmd";
import { normalizeCreditPolicy } from "./creditCommitment";
import type { CreditDeliveryState, ReceivingKeys } from "./types";

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}
function uint(value: bigint, bits: number, name: string): void {
    if (value < 0n || value >= 1n << BigInt(bits))
        throw new RangeError(`${name} out of uint${bits} range`);
}
function encode(value: bigint, length = 32): Uint8Array {
    uint(value, length * 8, "encoded value");
    const out = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) {
        out[i] = Number(value & 255n);
        value >>= 8n;
    }
    return out;
}
function decode(value: Uint8Array): bigint {
    return value.reduce((result, byte) => (result << 8n) | BigInt(byte), 0n);
}
function hexField(value: bigint): `0x${string}` {
    uint(value, 160, "owner address");
    return `0x${value.toString(16).padStart(40, "0")}`;
}
function receivingKeys(keys: ReceivingKeys): ReceivingKeys {
    if (
        !keys ||
        !(keys.viewingPublicKey instanceof Uint8Array) ||
        !(keys.clueKey instanceof Uint8Array)
    )
        throw new Error("receiving keys required");
    const viewingPublicKey = Uint8Array.from(keys.viewingPublicKey),
        clueKey = Uint8Array.from(keys.clueKey);
    if (viewingPublicKey.length !== 33 || (viewingPublicKey[0] !== 2 && viewingPublicKey[0] !== 3))
        throw new Error("invalid compressed viewing public key");
    secp256k1.ProjectivePoint.fromHex(viewingPublicKey).assertValidity();
    if (clueKey.length !== 32) throw new Error("invalid clue key length");
    validateClueKey(clueKey);
    return { viewingPublicKey, clueKey };
}

/** Copy and validate both public key snapshots without exporting any spending material. */
export function normalizeCreditDeliveryState(state: CreditDeliveryState): CreditDeliveryState {
    if (!state || typeof state !== "object" || !state.note || typeof state.note !== "object")
        throw new TypeError("complete Credit delivery state required");
    const note = structuredClone(state.note);
    return {
        note: {
            ...note,
            ...normalizeCreditPolicy(note),
        },
        ownerReceivingKeys: receivingKeys(state.ownerReceivingKeys),
        spenderReceivingKeys: receivingKeys(state.spenderReceivingKeys),
    };
}

/** Length-delimited application bytes are opaque to the fixed note decoder. */
function encodePayload(value?: Uint8Array): Uint8Array {
    if (value !== undefined && !(value instanceof Uint8Array))
        throw new TypeError("payload must be Uint8Array");
    const payload = value ?? new Uint8Array();
    if (payload.length > 65535) throw new RangeError("payload length exceeds uint16");
    return concat(encode(BigInt(payload.length), 2), payload);
}
function readPayload(plain: Uint8Array, offset: number): Uint8Array {
    if (plain.length < offset + 2) throw new Error("missing payload length");
    const length = Number(decode(plain.slice(offset, offset + 2)));
    if (plain.length !== offset + 2 + length) throw new Error("invalid payload length");
    return Uint8Array.from(plain.subarray(offset + 2));
}
export const fundsEnvelopeV1 = {
    kind: "funds" as const,
    version: 1,
    minimum: 160,
    maximum: 4096,
    encode(note: import("./types").Note) {
        return concat(
            encode(BigInt(note.walletIdentity)),
            encode(note.amount, 16),
            encode(note.nonce),
            encodePayload(note.payload)
        );
    },
    decode(plain: Uint8Array, context: import("./encryption").NoteDecryptionContext) {
        return {
            chainId: context.chainId,
            protocolAddress: context.protocolAddress,
            tokenAddress: context.tokenAddress,
            walletIdentity: hexField(decode(plain.slice(0, 32))),
            amount: decode(plain.slice(32, 48)),
            nonce: decode(plain.slice(48, 80)),
            payload: readPayload(plain, 80),
        };
    },
};
export const creditEnvelopeV1 = {
    kind: "credit" as const,
    version: 1,
    minimum: 498,
    maximum: 4096,
    encode(state: CreditDeliveryState) {
        return concat(
            encode(BigInt(state.note.spenderWalletIdentity)),
            encode(BigInt(state.note.ownerWalletIdentity)),
            encode(state.note.spenderPayout, 20),
            encode(state.note.ownerPayout, 20),
            encode(state.note.amount, 16),
            encode(state.note.nonce),
            encode(state.note.expiry, 8),
            encode(state.note.creditSharedKey),
            state.ownerReceivingKeys.viewingPublicKey,
            state.ownerReceivingKeys.clueKey,
            state.spenderReceivingKeys.viewingPublicKey,
            state.spenderReceivingKeys.clueKey,
            encode(state.note.singleLimit!, 16),
            encode(state.note.dailyLimit!, 16),
            encode(state.note.monthlyLimit!, 16),
            encode(state.note.lastDay!, 8),
            encode(state.note.dailySpent!, 16),
            encode(state.note.lastMonth!, 8),
            encode(state.note.monthlySpent!, 16),
            encodePayload(state.note.payload)
        );
    },
    decode(plain: Uint8Array, context: import("./encryption").CreditNoteDecryptionContext) {
        const note = {
            chainId: context.chainId,
            protocolAddress: context.protocolAddress,
            spenderWalletIdentity: hexField(decode(plain.slice(0, 32))),
            ownerWalletIdentity: hexField(decode(plain.slice(32, 64))),
            spenderPayout: decode(plain.slice(64, 84)),
            ownerPayout: decode(plain.slice(84, 104)),
            tokenAddress: context.tokenAddress,
            amount: decode(plain.slice(104, 120)),
            nonce: decode(plain.slice(120, 152)),
            expiry: decode(plain.slice(152, 160)),
            creditSharedKey: decode(plain.slice(160, 192)),
            singleLimit: decode(plain.slice(322, 338)),
            dailyLimit: decode(plain.slice(338, 354)),
            monthlyLimit: decode(plain.slice(354, 370)),
            lastDay: decode(plain.slice(370, 378)),
            dailySpent: decode(plain.slice(378, 394)),
            lastMonth: decode(plain.slice(394, 402)),
            monthlySpent: decode(plain.slice(402, 418)),
            payload: readPayload(plain, 418),
        };
        const state = normalizeCreditDeliveryState({
            note,
            ownerReceivingKeys: {
                viewingPublicKey: plain.slice(192, 225),
                clueKey: plain.slice(225, 257),
            },
            spenderReceivingKeys: {
                viewingPublicKey: plain.slice(257, 290),
                clueKey: plain.slice(290, 322),
            },
        });
        return { ...state, note: { ...state.note, payload: note.payload } };
    },
};
