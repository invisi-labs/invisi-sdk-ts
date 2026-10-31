import { getBytes, type BytesLike } from "ethers";

/** Stable transport resource bound, independent of encrypted payload versions. */
export const MAX_CIPHERTEXT_BYTES = 4096;
export type DeliveryKind = "funds" | "credit";

/** The high bit identifies the payload kind; the low seven bits identify its codec version. */
const CODECS = [
    Object.freeze({
        type: 0,
        kind: "funds",
        version: 1,
        minimum: 161,
        maximum: 502,
        domain: "Invisi.NoteDelivery.v1",
    } as const),
    Object.freeze({
        type: 1,
        kind: "credit",
        version: 1,
        minimum: 498,
        maximum: 754,
        domain: "Invisi.CreditDelivery.v1",
    } as const),
] as const;

export function deliveryHeader(kind: DeliveryKind, version = 1): number {
    if (kind !== "funds" && kind !== "credit") throw new Error("unsupported delivery kind");
    if (!Number.isInteger(version) || version < 1 || version > 127)
        throw new Error("delivery version must be 1..127");
    return (kind === "credit" ? 0x80 : 0) | version;
}

export function deliveryCodec(header: number) {
    if (!Number.isInteger(header) || header < 0 || header > 255)
        throw new Error("delivery header must be one byte");
    const type = header >>> 7;
    const version = header & 0x7f;
    const codec = CODECS.find((entry) => entry.type === type && entry.version === version);
    if (!codec) throw new Error(`unsupported ciphertext codec type ${type}, version ${version}`);
    return codec;
}

/** Validate a known codec locally; contracts and RPC intentionally treat these bytes as opaque. */
export function validateDeliveryCiphertext(value: BytesLike, kind?: DeliveryKind): Uint8Array {
    const data = Uint8Array.from(getBytes(value));
    if (data.length === 0 || data.length > MAX_CIPHERTEXT_BYTES)
        throw new Error("invalid envelope length");
    const codec = deliveryCodec(data[0]!);
    if (kind !== undefined && codec.kind !== kind) throw new Error("unexpected envelope kind");
    if (data.length < codec.minimum || data.length > codec.maximum)
        throw new Error("invalid envelope length");
    return data;
}
