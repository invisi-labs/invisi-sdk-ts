import { getAddress, isHexString } from "ethers";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";

export function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
export function address(value: string, label = "address"): Address {
    const result = getAddress(value) as Address;
    check(BigInt(result) !== 0n, `${label} must be nonzero`);
    return result;
}
export function same(a: string, b: string): boolean {
    return getAddress(a) === getAddress(b);
}
export function uint(value: bigint, bits: number, label: string, positive = false): bigint {
    check(
        typeof value === "bigint" && value >= (positive ? 1n : 0n) && value < 1n << BigInt(bits),
        `invalid ${label}`
    );
    return value;
}
export function hex(value: unknown, label = "data"): Hex {
    check(
        typeof value === "string" && isHexString(value) && value.length % 2 === 0,
        `invalid ${label}`
    );
    return value as Hex;
}
export function record(value: unknown, label: string): Record<string, unknown> {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `invalid ${label}`);
    return value as Record<string, unknown>;
}
export function decimal(value: unknown, label: string): bigint {
    check(typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value), `invalid ${label}`);
    return uint(BigInt(value), 256, label);
}
export function text(value: unknown, label: string): string {
    check(typeof value === "string", `invalid ${label}`);
    return value;
}
