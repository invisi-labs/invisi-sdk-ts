/** Fixed-width unsigned big-endian encoding; no runtime-specific bigint extension. */
export function uint(value: bigint, size: number, name: string): Uint8Array {
    if (typeof value !== "bigint" || value < 0n || value >= 1n << BigInt(size * 8))
        throw new RangeError(`${name} must be uint${size * 8}`);
    const result = new Uint8Array(size);
    for (let i = size - 1; i >= 0; i--) {
        result[i] = Number(value & 255n);
        value >>= 8n;
    }
    return result;
}
export function concat(parts: readonly Uint8Array[]): Uint8Array {
    const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
        result.set(part, offset);
        offset += part.length;
    }
    return result;
}
export class Reader {
    #offset = 0;
    constructor(readonly data: Uint8Array) {}
    take(size: number): Uint8Array {
        if (this.#offset + size > this.data.length) throw new Error("Truncated payment request");
        const result = this.data.slice(this.#offset, this.#offset + size);
        this.#offset += size;
        return result;
    }
    integer(size: number): bigint {
        return this.take(size).reduce((n, b) => (n << 8n) | BigInt(b), 0n);
    }
    done(): void {
        if (this.#offset !== this.data.length) throw new Error("Trailing payment request bytes");
    }
}
