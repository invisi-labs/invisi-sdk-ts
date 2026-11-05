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
const credit = {
    chainId,
    tokenAddress,
    spenderWalletIdentity: ownerHex(vectors.credit.spenderWalletIdentity),
    ownerWalletIdentity: ownerHex(vectors.credit.ownerWalletIdentity),
    spenderPayout:
        `0x${BigInt(vectors.credit.spenderPayout).toString(16).padStart(40, "0")}` as `0x${string}`,
    ownerPayout:
        `0x${BigInt(vectors.credit.ownerPayout).toString(16).padStart(40, "0")}` as `0x${string}`,
    amount: BigInt(vectors.credit.amount),
    nonce: BigInt(vectors.credit.nonce),
    expiry: BigInt(vectors.credit.expiry),
    creditSharedKey: BigInt(vectors.credit.creditSharedKey),
    singleLimit: BigInt(vectors.credit.singleLimit),
    dailyLimit: BigInt(vectors.credit.dailyLimit),
    monthlyLimit: BigInt(vectors.credit.monthlyLimit),
    lastDay: BigInt(vectors.credit.lastDay),
    dailySpent: BigInt(vectors.credit.dailySpent),
    lastMonth: BigInt(vectors.credit.lastMonth),
    monthlySpent: BigInt(vectors.credit.monthlySpent),
    creditCommitment: vectors.credit.commitment as `0x${string}`,
};

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
    it("accepts the independent complete Credit leaf", async () => {
        expect(await verifyCreditCommitment(credit)).toBe(true);
    });
    it("returns false when the server folded a tampered nonce", async () => {
        expect(await verifyCreditCommitment({ ...credit, nonce: credit.nonce + 1n })).toBe(false);
    });
    it("rejects a substituted shared key and noncanonical shared keys", async () => {
        expect(
            await verifyCreditCommitment({
                ...credit,
                creditSharedKey: credit.creditSharedKey + 1n,
            })
        ).toBe(false);
        for (const creditSharedKey of [-1n, 0n, FIELD_MODULUS])
            await expect(verifyCreditCommitment({ ...credit, creditSharedKey })).rejects.toThrow();
    });
    it("binds both wallet roles and both payout addresses", async () => {
        for (const changed of [
            {
                ...credit,
                spenderWalletIdentity: ownerHex(BigInt(credit.spenderWalletIdentity) + 1n),
            },
            { ...credit, ownerWalletIdentity: ownerHex(BigInt(credit.ownerWalletIdentity) + 1n) },
            { ...credit, spenderPayout: `0x${"11".repeat(20)}` as `0x${string}` },
            { ...credit, ownerPayout: `0x${"22".repeat(20)}` as `0x${string}` },
        ]) {
            await expect(verifyCreditCommitment(changed)).rejects.toThrow(/payout/);
        }
    });
});

function ownerHex(value: string | number | bigint): `0x${string}` {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}
