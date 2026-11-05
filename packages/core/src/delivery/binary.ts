import { FIELD_MODULUS } from "../crypto/random";
import { NoteBytes } from "./types";

export const ascii = (value: string) =>
    Uint8Array.from(value, (character) => character.charCodeAt(0));

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((size, p) => size + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

export function bytes(value: NoteBytes, length: number): Uint8Array {
    let out: Uint8Array;
    if (typeof value === "string") {
        if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error("invalid hexadecimal bytes");
        out = Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => parseInt(b, 16));
    } else if (value instanceof Uint8Array) out = Uint8Array.from(value);
    else throw new Error("expected hexadecimal bytes or Uint8Array");
    if (out.length !== length) throw new Error(`expected ${length} bytes`);
    return out;
}

export function uint(value: bigint, bits: number, name: string): void {
    if (value < 0n || value >= 1n << BigInt(bits))
        throw new RangeError(`${name} out of uint${bits} range`);
}

export function field(value: bigint, name: string): void {
    if (value < 0n || value >= FIELD_MODULUS)
        throw new RangeError(`${name} out of BN254 field range`);
}

export function encode(value: bigint, length = 32): Uint8Array {
    uint(value, length * 8, "encoded value");
    const out = new Uint8Array(length);
    for (let i = length - 1; i >= 0; i--) {
        out[i] = Number(value & 255n);
        value >>= 8n;
    }
    return out;
}

export function decode(value: Uint8Array): bigint {
    return value.reduce((n, b) => (n << 8n) | BigInt(b), 0n);
}

function hexField(value: bigint): `0x${string}` {
    uint(value, 160, "owner address");
    return `0x${value.toString(16).padStart(40, "0")}`;
}
