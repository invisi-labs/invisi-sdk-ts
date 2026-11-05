import type { Hex } from "@invisi-labs/core";
import { FIELD_MODULUS } from "@invisi-labs/core";
import { invalid } from "../transport/errors";
import type { CanonicalBlock } from "../types";

export function object(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return invalid("Expected RPC object");
    return value as Record<string, unknown>;
}

export function integer(value: unknown, bits = 64): bigint {
    if (
        (typeof value !== "number" || !Number.isSafeInteger(value)) &&
        (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    )
        return invalid("Invalid RPC integer");
    const n = BigInt(value as string | number);
    if (n < 0n || n >= 1n << BigInt(bits)) return invalid("RPC integer out of bounds");
    return n;
}

export function hash(value: unknown): Hex {
    if (typeof value !== "string" || !/^0x[\da-f]{64}$/i.test(value))
        return invalid("Invalid RPC hash");
    return value.toLowerCase() as Hex;
}

export function fieldHash(value: unknown): Hex {
    const h = hash(value);
    if (BigInt(h) >= FIELD_MODULUS) return invalid("Noncanonical Merkle field");
    return h;
}

export function numeric(value: bigint): number {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))
        return invalid("RPC numeric parameter exceeds safe integer range");
    return Number(value);
}

export function list(value: unknown): unknown[] {
    if (value === null) return [];
    if (!Array.isArray(value)) return invalid("Expected RPC array or null");
    return value;
}

export function blockReference(value: unknown): CanonicalBlock {
    const block = object(value);
    return {
        number: integer(block.number),
        hash: hash(block.hash),
        parentHash: hash(block.parentHash),
        timestamp: integer(block.timestamp),
    };
}
