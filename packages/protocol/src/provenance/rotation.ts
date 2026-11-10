import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { getBytes, hexlify, concat } from "ethers";
import { uint, word } from "./index";
import type { TrustContext } from "./index";
export interface RotationRecord {
    version: "1";
    providerId: string;
    oldKeyId: string;
    newKeyId: string;
    newPublicKey: string;
    activatedAt: string;
    previousRotationHash: string;
    signature: string;
}
export interface KeyValidity {
    activatedAt: string;
    retiredAt?: string;
}
export interface TrustedKeyring {
    providerId: string;
    keys: Record<string, Uint8Array>;
    validity: Record<string, KeyValidity>;
    rotationHash: string;
    lastActivatedAt: string;
}
const bytes32 = (v: string): Uint8Array => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error("Rotation field must be32-byte hex");
    return getBytes(v);
};
const time = (v: string): bigint => {
    if (!/^(0|[1-9][0-9]*)$/.test(v)) throw new Error("Rotation time must be decimal");
    return uint(v, 64);
};
export function rotationPayload(r: RotationRecord): Uint8Array {
    if (r.version !== "1") throw new Error("Unsupported rotation version");
    const pub = bytes32(r.newPublicKey),
        id = bytes32(r.newKeyId);
    if (hexlify(sha256(pub)) !== hexlify(id)) throw new Error("Rotation key ID mismatch");
    return getBytes(
        concat([
            new Uint8Array([1]),
            bytes32(r.providerId),
            bytes32(r.oldKeyId),
            id,
            pub,
            getBytes("0x" + time(r.activatedAt).toString(16).padStart(16, "0")),
            bytes32(r.previousRotationHash),
        ])
    );
}
export const rotationMessage = (r: RotationRecord): Uint8Array =>
    sha256(
        getBytes(
            concat([
                new TextEncoder().encode("Invisi.Provenance.KeyRotation.v1"),
                rotationPayload(r),
            ])
        )
    );
export const rotationHash = (r: RotationRecord): string => hexlify(sha256(rotationPayload(r)));
export function verifyRotationChain(
    initial: {
        providerId: string;
        keys: Readonly<Record<string, Uint8Array>>;
        previousRotationHash: string;
        lastActivatedAt: string;
        now: string;
        validity?: Readonly<Record<string, KeyValidity>>;
    },
    records: readonly RotationRecord[]
): TrustedKeyring {
    const provider = hexlify(bytes32(initial.providerId)),
        now = time(initial.now);
    let previous = hexlify(bytes32(initial.previousRotationHash)),
        last = time(initial.lastActivatedAt);
    if (last > now) throw new Error("Rotation checkpoint is in the future");
    const keys: Record<string, Uint8Array> = {},
        validity: Record<string, KeyValidity> = {};
    for (const [id, key] of Object.entries(initial.keys)) {
        const canonical = hexlify(bytes32(id));
        if (key.length !== 32) throw new Error("Invalid trusted signing key");
        keys[canonical] = new Uint8Array(key);
        validity[canonical] = { ...(initial.validity?.[canonical] ?? { activatedAt: "0" }) };
    }
    for (const r of records) {
        rotationPayload(r);
        const old = hexlify(bytes32(r.oldKeyId)),
            next = hexlify(bytes32(r.newKeyId)),
            at = time(r.activatedAt),
            oldKey = keys[old],
            interval = validity[old];
        if (
            hexlify(bytes32(r.providerId)) !== provider ||
            hexlify(bytes32(r.previousRotationHash)) !== previous ||
            at <= last ||
            at > now ||
            !oldKey ||
            !interval ||
            interval.retiredAt !== undefined ||
            at < time(interval.activatedAt) ||
            keys[next]
        )
            throw new Error("Untrusted or out-of-order key rotation");
        if (
            !/^0x[0-9a-fA-F]{128}$/.test(r.signature) ||
            !ed25519.verify(getBytes(r.signature), rotationMessage(r), oldKey, { zip215: false })
        )
            throw new Error("Invalid key rotation signature");
        validity[old] = { ...interval, retiredAt: r.activatedAt };
        keys[next] = bytes32(r.newPublicKey);
        validity[next] = { activatedAt: r.activatedAt };
        previous = rotationHash(r);
        last = at;
    }
    return {
        providerId: provider,
        keys,
        validity,
        rotationHash: previous,
        lastActivatedAt: last.toString(),
    };
}
export function withRotationHistory(trust: TrustContext, keyring: TrustedKeyring): TrustContext {
    if (word(trust.providerId) !== keyring.providerId)
        throw new Error("Rotation provider mismatch");
    return { ...trust, signingKeys: keyring.keys, signingKeyValidity: keyring.validity };
}
