import { FIELD_MODULUS } from "@invisi-labs/core";
import { verifyCreditCommitment, verifyNoteCommitment } from "@invisi-labs/protocol";
import { describe, expect, it } from "vitest";
import vectors from "../../../core/src/wallet/testdata/wallet-note-vectors.json";
const hex = (n: string | bigint): `0x${string}` => `0x${BigInt(n).toString(16).padStart(64, "0")}`;
const chainId = BigInt(vectors.context.chainId);
const tokenAddress = vectors.context.tokenAddress as `0x${string}`;
const note = {
    chainId,
    tokenAddress,
    ownerAddress: ownerHex(vectors.note.ownerAddress),
    amount: BigInt(vectors.note.amount),
    nonce: hex(vectors.note.nonce),
    noteCommitment: vectors.note.commitment as `0x${string}`,
};
const creditState = {
    chainId,
    protocolAddress: BigInt(vectors.context.protocolAddress),
    tokenAddress: BigInt(tokenAddress),
    ...Object.fromEntries(
        Object.entries(vectors.credit)
            .filter(([k]) =>
                [
                    "spenderWalletIdentity",
                    "ownerWalletIdentity",
                    "revocationShard",
                    "revocationSlot",
                    "nonce",
                    "expiry",
                    "creditSharedKey",
                    "singleLimit",
                    "dailyLimit",
                    "monthlyLimit",
                    "lifetimeLimit",
                    "lastDay",
                    "dailySpent",
                    "lastMonth",
                    "monthlySpent",
                    "totalSpent",
                ].includes(k)
            )
            .map(([k, v]) => [
                k,
                k.endsWith("Identity") ? ownerHex(v as string) : BigInt(v as string),
            ])
    ),
} as import("@invisi-labs/core").CreditState;
const credit = { state: creditState, creditCommitment: vectors.credit.commitment as `0x${string}` };

describe("verifyNoteCommitment", () => {
    it("accepts the independent current wallet note vector", async () => {
        expect(await verifyNoteCommitment(note)).toBe(true);
    });
    it("returns false for a tampered note commitment", async () => {
        expect(await verifyNoteCommitment({ ...note, noteCommitment: hex(1n) })).toBe(false);
    });
    it("returns false for wrong amount, wallet, nonce, token or chain", async () => {
        for (const changed of [
            { ...note, amount: note.amount + 1n },
            { ...note, ownerAddress: ownerHex(BigInt(note.ownerAddress) + 1n) },
            { ...note, nonce: hex(BigInt(note.nonce) + 1n) },
            { ...note, tokenAddress: hex(1n) },
            { ...note, chainId: chainId + 1n },
        ]) {
            expect(await verifyNoteCommitment(changed)).toBe(false);
        }
    });
    it("rejects noncanonical wallet, nonce and amount values", async () => {
        for (const changed of [
            { ...note, ownerAddress: ownerHex(0n) },
            { ...note, ownerAddress: ownerHex(FIELD_MODULUS) },
            { ...note, nonce: hex(FIELD_MODULUS) },
            { ...note, amount: 0n },
            { ...note, amount: 1n << 128n },
        ]) {
            await expect(verifyNoteCommitment(changed)).rejects.toThrow();
        }
    });
});

describe("verifyCreditCommitment", () => {
    it("verifies the current deployment-bound Credit leaf", async () => {
        expect(await verifyCreditCommitment(credit)).toBe(true);
        for (const field of [
            "nonce",
            "revocationShard",
            "revocationSlot",
            "lifetimeLimit",
            "totalSpent",
            "protocolAddress",
        ] as const)
            expect(
                await verifyCreditCommitment({
                    ...credit,
                    state: { ...credit.state, [field]: (credit.state[field] ?? 0n) + 1n },
                })
            ).toBe(false);
    });
    it("rejects noncanonical shared keys", async () => {
        for (const key of [-1n, 0n, FIELD_MODULUS])
            await expect(
                verifyCreditCommitment({
                    ...credit,
                    state: { ...credit.state, creditSharedKey: key },
                })
            ).rejects.toThrow();
    });
});

function ownerHex(value: string | number | bigint): `0x${string}` {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}
