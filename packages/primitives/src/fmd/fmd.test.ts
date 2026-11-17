import { describe, expect, it, vi } from "vitest";
import { createClue, createClueFromSeed, deriveClueKey, validateClueKey } from "./fmd.js";
import rust from "./testdata/fmd-rust-vectors.json";

const bytes = (hex: string) => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
const hex = (value: Uint8Array) =>
    Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
const frozen = {
    detectionKey: "767721ba8ba2c9f4031e0043050aa26662fecea8b9e3b6d8d5394c5eabf09a00",
    clueKey: "c69480518ea88f8cb925fbcd8f5100b1ebc46cc4d8cbe19e0478936567e6b211",
    clue: "3afb2a6a358773428ec79e6b3f0c617e35e703cfb2fee280aa5646d073f8640fc8d5749b12b881e2293043a71915487b1cd47462f883747d283ead654c79240418c05c88",
};

describe("S-FMD pinned decaf377-fmd 2.1.1 compatibility", () => {
    it("derives the frozen Rust clue key and byte-identical deterministic clue", () => {
        expect(hex(deriveClueKey(bytes(frozen.detectionKey)))).toBe(frozen.clueKey);
        expect(hex(createClueFromSeed(bytes(frozen.clueKey), new Uint8Array(32).fill(42)))).toBe(
            frozen.clue
        );
    });
    it("matches independent randomized Rust clue creation", () => {
        for (const vector of rust.vectors) {
            expect(hex(deriveClueKey(bytes(vector.detectionKey)))).toBe(vector.clueKey);
            expect(hex(createClueFromSeed(bytes(vector.clueKey), bytes(vector.seedHex)))).toBe(
                vector.clue
            );
        }
    }, 60_000);
});

describe("S-FMD input and isolation boundaries", () => {
    it("accepts exactly the independent Rust canonical nonidentity point corpus", async () => {
        const { default: corpus } = await import("./testdata/decaf377-clue-keys.json");
        expect(corpus.length).toBe(322);
        for (const vector of corpus) {
            const check = () => validateClueKey(bytes(vector.key.slice(2)));
            if (vector.valid) expect(check, vector.key).not.toThrow();
            else expect(check, vector.key).toThrow();
        }
    });
    it("rejects zero, modulus, overflow, and incorrectly typed detection keys", () => {
        const invalid: unknown[] = [
            new Uint8Array(32),
            new Uint8Array(31),
            new Uint8Array(33),
            bytes("ff3e5c15c494a99f94e48ddf37b5d5e0b30a6fe05fa6d19d28b3310bffdfaa04"),
            new Uint8Array(32).fill(255),
            Array(32).fill(1),
            "01".repeat(32),
            null,
        ];
        // Scalar modulus as an independent decimal literal, encoded only in test code.
        let modulus = 2111115437357092606062206234695386632838870926408408195193685246394721360383n;
        const scalarModulus = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            scalarModulus[i] = Number(modulus & 255n);
            modulus >>= 8n;
        }
        invalid.push(scalarModulus);
        for (const key of invalid) {
            expect(() => deriveClueKey(key as Uint8Array)).toThrow();
        }
        const scalarOne = new Uint8Array(32);
        scalarOne[0] = 1;
        expect(hex(deriveClueKey(scalarOne))).toBe(
            "0800000000000000000000000000000000000000000000000000000000000000"
        );
    });
    it("rejects malformed clue keys and seeds", () => {
        for (const invalid of [
            new Uint8Array(31),
            new Uint8Array(33),
            new Uint8Array(32),
            new Uint8Array(32).fill(255),
        ]) {
            expect(() => validateClueKey(invalid)).toThrow();
            expect(() => createClueFromSeed(invalid, new Uint8Array(32))).toThrow();
        }
        for (const invalid of [new Uint8Array(31), new Uint8Array(33), null, Array(32).fill(0)]) {
            expect(() =>
                createClueFromSeed(bytes(frozen.clueKey), invalid as Uint8Array)
            ).toThrow();
        }
    });
    it("creates fresh securely seeded fixed-precision clues in the runtime", () => {
        const key = bytes(frozen.clueKey);
        const first = createClue(key);
        const second = createClue(key);
        expect(first).toHaveLength(68);
        expect(first[64]).toBe(24);
        expect(hex(first)).not.toBe(hex(second));
    });
});

it("uses the supplied WebCrypto entropy and fails if secure randomness is absent", () => {
    try {
        vi.stubGlobal("crypto", { getRandomValues: (out: Uint8Array) => out.fill(42) });
        expect(hex(createClue(bytes(frozen.clueKey)))).toBe(frozen.clue);
        vi.stubGlobal("crypto", undefined);
        expect(() => createClue(bytes(frozen.clueKey))).toThrow("WebCrypto");
    } finally {
        vi.unstubAllGlobals();
    }
});

it("does not bind public-key precomputation to mutable caller buffers", () => {
    const vector = rust.vectors[0]!;
    const key = bytes(vector.clueKey);
    const seed = bytes(vector.seedHex);
    expect(hex(createClueFromSeed(key, seed))).toBe(vector.clue);
    key.fill(0);
    expect(() => createClueFromSeed(key, seed)).toThrow();
    key.set(bytes(vector.clueKey));
    for (const entry of rust.vectors.slice(1, 12)) {
        expect(hex(createClueFromSeed(bytes(entry.clueKey), bytes(entry.seedHex)))).toBe(
            entry.clue
        );
    }
    expect(hex(createClueFromSeed(key, seed))).toBe(vector.clue);
});
