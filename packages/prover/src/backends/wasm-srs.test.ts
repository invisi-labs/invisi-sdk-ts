import { describe, expect, it } from "vitest";
import { wasmSrsSize } from "./wasm-srs";

describe("Barretenberg WASM SRS size", () => {
    it.each([
        [16, 131_072],
        [17, 262_144],
        [19, 655_360],
    ])("includes the extra point and rounds 2^%i to complete batches", (logN, expected) => {
        const key = new Uint8Array(32);
        key[31] = logN;
        expect(wasmSrsSize(key)).toBe(expected);
    });

    it.each([new Uint8Array(31).fill(16), new Uint8Array(32), new Uint8Array(32).fill(255)])(
        "rejects malformed verification keys before allocating an SRS (%#)",
        (key) => {
            expect(() => wasmSrsSize(key)).toThrow("Invalid verification key circuit size");
        }
    );
});
