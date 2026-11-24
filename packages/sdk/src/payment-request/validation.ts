import { FIELD_MODULUS, MAX_CIPHERTEXT_BYTES, ReceivingAddress } from "@invisi-labs/primitives";
import { getAddress } from "ethers/address";
import { uint } from "./binary";
import type { PaymentRequest } from "./types";

/** Funds envelope v1 consists of 160 fixed bytes plus the raw application payload. */
export const MAX_REQUEST_PAYLOAD_BYTES = MAX_CIPHERTEXT_BYTES - 160;
export function fields(value: unknown, allowed: readonly string[], name: string): void {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new TypeError(`Invalid ${name}`);
    for (const key of Object.keys(value))
        if (!allowed.includes(key)) throw new TypeError(`Unsupported ${name} field ${key}`);
}
export function nonce(value: bigint): bigint {
    uint(value, 32, "nonce");
    if (value >= FIELD_MODULUS)
        throw new RangeError("nonce must be a canonical BN254 field element");
    return value;
}
export function validatePaymentRequest(request: PaymentRequest): void {
    fields(
        request,
        ["chainId", "protocolAddress", "tokenAddress", "amount", "recipient", "payload"],
        "payment request"
    );
    uint(request.chainId, 8, "chainId");
    if (request.chainId === 0n) throw new RangeError("chainId must be positive");
    const protocol = getAddress(request.protocolAddress);
    getAddress(request.tokenAddress);
    if (BigInt(protocol) === 0n) throw new RangeError("protocol address must be nonzero");
    uint(request.amount, 16, "amount");
    if (request.amount === 0n) throw new RangeError("amount must be positive");
    const recipient = request.recipient;
    fields(
        recipient,
        ["type", "address", "nonce", "identity", "envelope", "addressLookup"],
        "recipient"
    );
    if (recipient.type === "identity") {
        fields(recipient, ["type", "identity"], "identity recipient");
        if (
            typeof recipient.identity !== "string" ||
            !/^0x[\da-f]{64}$/i.test(recipient.identity) ||
            BigInt(recipient.identity) <= 0n ||
            BigInt(recipient.identity) >= FIELD_MODULUS
        )
            throw new RangeError("identity must be a nonzero canonical BN254 field element");
        if (request.payload !== undefined)
            throw new TypeError("payload requires an encrypted envelope");
        return;
    }
    if (recipient.type !== "evm" && recipient.type !== "invisi")
        throw new TypeError("Invalid recipient type");
    fields(
        recipient,
        recipient.type === "evm"
            ? ["type", "address", "nonce", "envelope", "addressLookup"]
            : ["type", "address", "nonce"],
        "recipient"
    );
    const parsed = ReceivingAddress.parse(recipient.address);
    if ((recipient.type === "evm") !== (parsed.kind === "short"))
        throw new TypeError("recipient address type mismatch");
    if (BigInt(parsed.ownerAddress) === 0n) throw new RangeError("owner address must be nonzero");
    if (recipient.nonce !== undefined) nonce(recipient.nonce);
    if (recipient.type === "evm") {
        if (recipient.envelope !== undefined && typeof recipient.envelope !== "boolean")
            throw new TypeError("evm envelope must be boolean");
        if (
            recipient.addressLookup !== undefined &&
            !["chain", "protocol-rpc"].includes(recipient.addressLookup)
        )
            throw new TypeError("Invalid recipient addressLookup");
        if (recipient.envelope === false && request.payload !== undefined)
            throw new TypeError("payload requires an encrypted envelope");
    }
    if (request.payload !== undefined && !(request.payload instanceof Uint8Array))
        throw new TypeError("payload must be Uint8Array");
    if ((request.payload?.length ?? 0) > MAX_REQUEST_PAYLOAD_BYTES)
        throw new RangeError("payload exceeds funds envelope limit");
}
