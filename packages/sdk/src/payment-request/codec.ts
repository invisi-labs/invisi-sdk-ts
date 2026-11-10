import { ReceivingAddress } from "@invisi-labs/primitives";
import { decodeBase64, encodeBase64, getBytes, hexlify } from "ethers";
import { concat, Reader, uint } from "./binary";
import type { PaymentRequest, NoteOutputRecipient } from "./types";
import { MAX_REQUEST_PAYLOAD_BYTES, validatePaymentRequest } from "./validation";

const PREFIX = "ipr:";
const VERSION = 1;
const MAX_BINARY_BYTES = 186 + MAX_REQUEST_PAYLOAD_BYTES;
function base64url(data: Uint8Array): string {
    return encodeBase64(data).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Encode only the request, never the current output nonce or local registry lookup choice. */
export function encodePaymentRequest(request: PaymentRequest): string {
    validatePaymentRequest(request);
    const recipient = request.recipient;
    const parts = [
        new Uint8Array([
            VERSION,
            recipient.type === "evm" ? 1 : recipient.type === "invisi" ? 2 : 3,
        ]),
        uint(request.chainId, 8, "chainId"),
        getBytes(request.protocolAddress),
        getBytes(request.tokenAddress),
        uint(request.amount, 16, "amount"),
    ];
    if (recipient.type === "identity") parts.push(getBytes(recipient.identity));
    else {
        const parsed = ReceivingAddress.parse(recipient.address);
        parts.push(getBytes(parsed.ownerAddress));
        if (recipient.type === "invisi") {
            const keys = parsed.getReceivingKeys();
            parts.push(keys.viewingPublicKey, keys.clueKey);
        } else parts.push(new Uint8Array([recipient.envelope === false ? 0 : 1]));
        parts.push(new Uint8Array([recipient.nonce === undefined ? 0 : 1]));
        if (recipient.nonce !== undefined) parts.push(uint(recipient.nonce, 32, "nonce"));
        if (recipient.type === "invisi" || recipient.envelope !== false) {
            const payload = request.payload ?? new Uint8Array();
            parts.push(uint(BigInt(payload.length), 2, "payloadLength"), payload);
        }
    }
    return PREFIX + base64url(concat(parts));
}

/** Decode a canonical Note request offline, with exact resource and byte-layout checks. */
export function decodePaymentRequest(encoded: string): PaymentRequest {
    if (
        typeof encoded !== "string" ||
        !encoded.startsWith(PREFIX) ||
        encoded.length > 4 + Math.ceil((MAX_BINARY_BYTES * 8) / 6)
    )
        throw new Error("Invalid payment request encoding");
    const text = encoded.slice(PREFIX.length);
    if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1)
        throw new Error("Invalid payment request Base64URL");
    const data = decodeBase64(
        text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4)
    );
    if (base64url(data) !== text) throw new Error("Noncanonical payment request Base64URL");
    const reader = new Reader(data);
    if (reader.integer(1) !== BigInt(VERSION))
        throw new Error("Unsupported payment request version");
    const type = reader.integer(1);
    if (type < 1n || type > 3n) throw new Error("Unsupported payment request recipient type");
    const context = {
        chainId: reader.integer(8),
        protocolAddress: hexlify(reader.take(20)) as `0x${string}`,
        tokenAddress: hexlify(reader.take(20)) as `0x${string}`,
        amount: reader.integer(16),
    };
    let recipient: NoteOutputRecipient;
    let payload: Uint8Array | undefined;
    if (type === 3n)
        recipient = { type: "identity", identity: hexlify(reader.take(32)) as `0x${string}` };
    else {
        const ownerAddress = hexlify(reader.take(20)) as `0x${string}`;
        let address: string;
        let envelope = true;
        if (type === 2n)
            address = ReceivingAddress.from({
                ownerAddress,
                viewingPublicKey: reader.take(33),
                clueKey: reader.take(32),
            }).toString();
        else {
            address = ReceivingAddress.fromIdentity(ownerAddress).toString();
            const value = reader.integer(1);
            if (value > 1n) throw new Error("Invalid envelope flag");
            envelope = value === 1n;
        }
        const present = reader.integer(1);
        if (present > 1n) throw new Error("Invalid nonce presence flag");
        const nonce = present === 1n ? reader.integer(32) : undefined;
        recipient =
            type === 2n
                ? { type: "invisi", address, ...(nonce === undefined ? {} : { nonce }) }
                : { type: "evm", address, envelope, ...(nonce === undefined ? {} : { nonce }) };
        if (envelope) {
            const length = Number(reader.integer(2));
            if (length > MAX_REQUEST_PAYLOAD_BYTES)
                throw new RangeError("payload exceeds funds envelope limit");
            if (length !== 0) payload = reader.take(length);
        }
    }
    reader.done();
    const request = {
        ...context,
        recipient,
        ...(payload === undefined ? {} : { payload }),
    } as PaymentRequest;
    validatePaymentRequest(request);
    if (encodePaymentRequest(request) !== encoded) throw new Error("Noncanonical payment request");
    return request;
}
