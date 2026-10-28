import { describe, it, expect } from "vitest";
import { computeNoteNullifier } from "./nullifier";
import { computeNoteIdentity, computeNoteCommitment } from "./commitment";
import { FIELD_MODULUS } from "./random";
import vectors from "./testdata/wallet-note-vectors.json";

const CHAIN_ID = BigInt(vectors.context.chainId);
const KEY = BigInt(vectors.note.nonce);
const COMMITMENT = vectors.note.commitment as `0x${string}`;
const hex = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const leaf = async (
    nonce = 123n,
    token = BigInt(vectors.context.tokenAddress),
    amount = 70n,
    wallet = BigInt(vectors.note.walletIdentity)
) => computeNoteCommitment(CHAIN_ID, await computeNoteIdentity(wallet, nonce), token, amount);

describe("computeNoteNullifier", () => {
    it("matches the independent current protocol nullifier vector", async () => {
        expect(await computeNoteNullifier(CHAIN_ID, KEY, COMMITMENT)).toBe(vectors.note.nullifier);
    });
    it("is deterministic and returns a canonical hex string", async () => {
        const result = await computeNoteNullifier(CHAIN_ID, KEY, COMMITMENT);
        expect(result).toMatch(/^0x[0-9a-f]{64}$/);
        expect(await computeNoteNullifier(CHAIN_ID, KEY, COMMITMENT)).toBe(result);
    });
    it("different note nonces produce different nullifiers", async () => {
        expect(await computeNoteNullifier(CHAIN_ID, KEY, await leaf(124n))).not.toBe(
            vectors.note.nullifier
        );
    });
    it("different tokens produce different nullifiers", async () => {
        expect(await computeNoteNullifier(CHAIN_ID, KEY, await leaf(123n, 0xcafen))).not.toBe(
            vectors.note.nullifier
        );
    });
    it("different chain IDs produce different nullifiers even for the same leaf", async () => {
        expect(await computeNoteNullifier(CHAIN_ID + 1n, KEY, COMMITMENT)).not.toBe(
            vectors.note.nullifier
        );
    });
    it("different note nonces produce different nullifiers", async () => {
        expect(await computeNoteNullifier(CHAIN_ID, KEY + 1n, COMMITMENT)).not.toBe(
            vectors.note.nullifier
        );
    });
    it("binds the complete leaf including amount and wallet identity", async () => {
        for (const commitment of [
            await leaf(123n, BigInt(vectors.context.tokenAddress), 71n),
            await leaf(
                123n,
                BigInt(vectors.context.tokenAddress),
                70n,
                BigInt(vectors.note.walletIdentity) + 1n
            ),
        ]) {
            expect(await computeNoteNullifier(CHAIN_ID, KEY, commitment)).not.toBe(
                vectors.note.nullifier
            );
        }
    });
    it("enforces canonical fields, a canonical nonce, and the u64 chain boundary", async () => {
        for (const key of [-1n, FIELD_MODULUS])
            await expect(computeNoteNullifier(CHAIN_ID, key, COMMITMENT)).rejects.toThrow();
        for (const chain of [-1n, 1n << 64n])
            await expect(computeNoteNullifier(chain, KEY, COMMITMENT)).rejects.toThrow();
        for (const commitment of ["0x01", "0x" + "z".repeat(64), hex(FIELD_MODULUS)])
            await expect(
                computeNoteNullifier(CHAIN_ID, KEY, commitment as `0x${string}`)
            ).rejects.toThrow();
        await expect(
            computeNoteNullifier((1n << 64n) - 1n, FIELD_MODULUS - 1n, COMMITMENT)
        ).resolves.toMatch(/^0x[0-9a-f]{64}$/);
        await expect(computeNoteNullifier(0n, 1n, COMMITMENT)).resolves.toMatch(/^0x[0-9a-f]{64}$/);
    });
});
