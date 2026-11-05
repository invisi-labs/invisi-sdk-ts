import { getBytes, type BytesLike } from "ethers";
import { creditEnvelopeV1, fundsEnvelopeV1 } from "./note-payload";

/** Stable transport resource bound; applications do not select the SDK envelope version. */
export const MAX_CIPHERTEXT_BYTES = 4096;
export type DeliveryKind = "funds" | "credit";
export function deliveryHeader(kind: DeliveryKind): number {
    if (kind !== "funds" && kind !== "credit") throw new Error("unsupported delivery kind");
    return kind === "credit" ? 0x81 : 0x01;
}
export function decodeDeliveryHeader(header: number): { kind: DeliveryKind; version: number } {
    if (!Number.isInteger(header) || header < 0 || header > 255)
        throw new Error("delivery header must be one byte");
    const kind = header >>> 7 ? "credit" : "funds";
    const version = header & 0x7f;
    if (version === 0) throw new Error("invalid envelope version");
    return { kind, version };
}
/** Dispatch only SDK-owned envelope implementations. Future versions are added here. */
export function deliveryCodec(header: number) {
    const { kind, version } = decodeDeliveryHeader(header);
    if (version !== 1) throw new Error(`unsupported envelope version ${version}`);
    const codec = kind === "funds" ? fundsEnvelopeV1 : creditEnvelopeV1;
    return { ...codec, domain: `Invisi.${kind === "funds" ? "Note" : "Credit"}Delivery.v1` };
}
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
