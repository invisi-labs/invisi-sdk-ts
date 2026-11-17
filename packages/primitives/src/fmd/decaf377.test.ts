import { describe, expect, it } from "vitest";
import { Field } from "@noble/curves/abstract/modular";
import { blake2b } from "@noble/hashes/blake2b";
import { FQ, inverseSquareRoot, readLE } from "./decaf377";

const field = Field(FQ);

describe("Decaf377 inverse square root", () => {
    it("uses the base field two-adic decomposition and a quadratic nonresidue", () => {
        const odd = (FQ - 1n) >> 47n;
        expect(odd * (1n << 47n)).toBe(FQ - 1n);
        expect(odd & 1n).toBe(1n);
        expect(field.pow(11n, (FQ - 1n) / 2n)).toBe(FQ - 1n);
    });
    it("matches the generic field square-root constraint across deterministic field samples", () => {
        for (let i = 0; i < 256; i++) {
            const bytes = new Uint8Array(32);
            new DataView(bytes.buffer).setUint32(0, i);
            const value = (readLE(blake2b(bytes)) % (FQ - 1n)) + 1n;
            const denominator = (value * value) % FQ;
            const expected = field.sqrt(field.inv(denominator));
            const actual = inverseSquareRoot(denominator);
            expect(actual === expected || actual === FQ - expected).toBe(true);
            expect((((actual * actual) % FQ) * denominator) % FQ).toBe(1n);
            expect(() => inverseSquareRoot((denominator * 11n) % FQ)).toThrow();
        }
    });
    it("rejects zero and out-of-field encodings", () => {
        for (const value of [0n, -1n, FQ, FQ + 1n])
            expect(() => inverseSquareRoot(value)).toThrow();
        expect(inverseSquareRoot(1n)).toBe(1n);
    });
});
