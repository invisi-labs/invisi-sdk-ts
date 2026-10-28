import { describe, it, expect, vi, afterEach } from "vitest";
import { generateNonce, generateCreditSharedKey, FIELD_MODULUS } from "./random";

describe("AUDIT-042: generateNonce", () => {
    it("returns a bigint", () => {
        const nonce = generateNonce();
        expect(typeof nonce).toBe("bigint");
    });

    it("returns a value less than FIELD_MODULUS", () => {
        for (let i = 0; i < 20; i++) {
            const nonce = generateNonce();
            expect(nonce).toBeGreaterThanOrEqual(0n);
            expect(nonce).toBeLessThan(FIELD_MODULUS);
        }
    });

    it("returns different values on successive calls (randomness)", () => {
        const nonces = new Set<bigint>();
        for (let i = 0; i < 10; i++) {
            nonces.add(generateNonce());
        }
        // With 256-bit randomness, 10 calls should produce 10 unique values
        expect(nonces.size).toBe(10);
    });
});

describe("canonical rejection sampling", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });
    function entropy(values: bigint[]) {
        const getRandomValues = vi.fn((target: Uint8Array) => {
            const value = values.shift();
            if (value === undefined) throw new Error("unexpected entropy request");
            const bytes = value
                .toString(16)
                .padStart(64, "0")
                .match(/../g)!
                .map((x) => parseInt(x, 16));
            target.set(bytes);
            return target;
        });
        vi.stubGlobal("crypto", { getRandomValues });
        return getRandomValues;
    }
    it("rejects field overflow rather than reducing it modulo p", () => {
        const source = entropy([FIELD_MODULUS, 42n]);
        expect(generateNonce()).toBe(42n);
        expect(source).toHaveBeenCalledTimes(2);
    });
    it("allows zero as a canonical nonce", () => {
        entropy([0n]);
        expect(generateNonce()).toBe(0n);
    });
    it("generates a nonzero credit key and rejects zero and overflow", () => {
        const source = entropy([0n, FIELD_MODULUS, (1n << 256n) - 1n, 75n]);
        expect(generateCreditSharedKey()).toBe(75n);
        expect(source).toHaveBeenCalledTimes(4);
    });
});
