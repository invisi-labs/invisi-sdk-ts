import { FIELD_MODULUS } from "@invisi-labs/core";
import { decodeBase64, encodeBase64, getAddress, getBytes, hexlify, concat } from "ethers";
import type { PaymentNoteData } from "./types";

function uint(value: bigint, bytes: number): Uint8Array {
    if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(bytes * 8))
        throw new RangeError(`Invalid uint${bytes * 8} payment note field`);
    return getBytes(`0x${value.toString(16).padStart(bytes * 2, "0")}`);
}
function validate(value: PaymentNoteData): void {
    const keys = [
        "chainId",
        "protocolAddress",
        "tokenAddress",
        "amount",
        "ownerAddress",
        "nonce",
        "commitment",
    ];
    if (
        !value ||
        typeof value !== "object" ||
        Object.keys(value).some((key) => !keys.includes(key))
    )
        throw new TypeError("Invalid payment note fields");
    uint(value.chainId, 8);
    uint(value.amount, 16);
    if (value.chainId === 0n || value.amount === 0n)
        throw new RangeError("Positive chainId and amount required");
    for (const key of ["protocolAddress", "ownerAddress", "tokenAddress"] as const) {
        getAddress(value[key]);
        if (key !== "tokenAddress" && BigInt(value[key]) === 0n)
            throw new RangeError(`Invalid ${key}`);
    }
    uint(value.nonce, 32);
    if (value.nonce >= FIELD_MODULUS) throw new RangeError("Invalid payment note nonce");
    if (
        !/^0x[\da-f]{64}$/i.test(value.commitment) ||
        BigInt(value.commitment) <= 0n ||
        BigInt(value.commitment) >= FIELD_MODULUS
    )
        throw new RangeError("Invalid payment note commitment");
}
export function encodePaymentNote(value: PaymentNoteData): string {
    validate(value);
    const bytes = concat([
        new Uint8Array([1]),
        uint(value.chainId, 8),
        getBytes(value.protocolAddress),
        getBytes(value.tokenAddress),
        uint(value.amount, 16),
        getBytes(value.ownerAddress),
        uint(value.nonce, 32),
        getBytes(value.commitment),
    ]);
    return `ipn:${encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}
export function decodePaymentNote(encoded: string): PaymentNoteData {
    if (
        typeof encoded !== "string" ||
        encoded.length !== 203 ||
        !/^ipn:[A-Za-z0-9_-]+$/.test(encoded)
    )
        throw new TypeError("Invalid payment note encoding");
    const bytes = decodeBase64(encoded.slice(4).replace(/-/g, "+").replace(/_/g, "/") + "=");
    if (bytes.length !== 149 || bytes[0] !== 1)
        throw new Error("Unsupported payment note version or length");
    let offset = 1;
    const take = (size: number) => {
        const value = hexlify(bytes.slice(offset, (offset += size))) as `0x${string}`;
        return value;
    };
    const value: PaymentNoteData = {
        chainId: BigInt(take(8)),
        protocolAddress: getAddress(take(20)) as `0x${string}`,
        tokenAddress: getAddress(take(20)) as `0x${string}`,
        amount: BigInt(take(16)),
        ownerAddress: getAddress(take(20)).toLowerCase() as `0x${string}`,
        nonce: BigInt(take(32)),
        commitment: take(32),
    };
    if (encodePaymentNote(value) !== encoded) throw new Error("Noncanonical payment note encoding");
    return value;
}
