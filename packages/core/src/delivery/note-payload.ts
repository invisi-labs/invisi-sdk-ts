import { secp256k1 } from "@noble/curves/secp256k1";
import { validateClueKey } from "../fmd/fmd";
import { normalizeCreditPolicy, normalizeCreditState } from "../credit/state";
import type { CreditDeliveryState, ReceivingKeys } from "../types";

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
    const allowed = [
        "chainId",
        "protocolAddress",
        "tokenAddress",
        "spenderWalletIdentity",
        "ownerWalletIdentity",
        "revocationShard",
        "revocationSlot",
        "nonce",
        "expiry",
        "creditSharedKey",
        "singleLimit",
        "dailyLimit",
        "monthlyLimit",
        "availableCredit",
        "unlimited",
        "lastDay",
        "dailySpent",
        "lastMonth",
        "monthlySpent",
        "totalSpent",
        "payload",
    ];
    if (Object.keys(state.note).some((k) => !allowed.includes(k)))
        throw Error("Unsupported Credit fields");
    const note = normalizeCreditState(structuredClone(state.note));
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
    encode(note: import("../types").Note) {
        return concat(
            encode(BigInt(note.ownerAddress)),
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
            ownerAddress: hexField(decode(plain.slice(0, 32))),
            amount: decode(plain.slice(32, 48)),
            nonce: decode(plain.slice(48, 80)),
            payload: readPayload(plain, 80),
        };
    },
};
const creditWireFields = [
    ["spenderWalletIdentity", 32],
    ["ownerWalletIdentity", 32],
    ["revocationShard", 8],
    ["revocationSlot", 2],
    ["nonce", 32],
    ["expiry", 8],
    ["creditSharedKey", 32],
    ["singleLimit", 16],
    ["dailyLimit", 16],
    ["monthlyLimit", 16],
    ["availableCredit", 16],
    ["unlimited", 1],
    ["lastDay", 8],
    ["dailySpent", 16],
    ["lastMonth", 8],
    ["monthlySpent", 16],
    ["totalSpent", 16],
] as const;
export const creditEnvelopeV2 = {
    kind: "credit" as const,
    version: 2,
    minimum: 485,
    maximum: 4096,
    encode(input: CreditDeliveryState) {
        const state = normalizeCreditDeliveryState(input);
        return concat(
            ...creditWireFields.map(([k, size]) => encode(BigInt(state.note[k]!), size)),
            state.ownerReceivingKeys.viewingPublicKey,
            state.ownerReceivingKeys.clueKey,
            state.spenderReceivingKeys.viewingPublicKey,
            state.spenderReceivingKeys.clueKey,
            encodePayload(state.note.payload)
        );
    },
    decode(plain: Uint8Array, context: import("./encryption").CreditStateDecryptionContext) {
        let offset = 0;
        const note: Record<string, unknown> = {
            chainId: context.chainId,
            protocolAddress: context.protocolAddress,
            tokenAddress: context.tokenAddress,
        };
        for (const [k, size] of creditWireFields) {
            const n = decode(plain.slice(offset, offset + size));
            if (k === "unlimited" && n !== 0n && n !== 1n)
                throw Error("invalid Credit unlimited byte");
            note[k] = k === "unlimited" ? n === 1n : k.endsWith("Identity") ? hexField(n) : n;
            offset += size;
        }
        const keys = () => {
            const k = {
                viewingPublicKey: plain.slice(offset, offset + 33),
                clueKey: plain.slice(offset + 33, offset + 65),
            };
            offset += 65;
            return k;
        };
        const ownerReceivingKeys = keys(),
            spenderReceivingKeys = keys();
        note.payload = readPayload(plain, offset);
        return normalizeCreditDeliveryState({
            note: note as unknown as import("../types").CreditState,
            ownerReceivingKeys,
            spenderReceivingKeys,
        });
    },
};
