import { describe, it, expect } from "vitest";
import * as core from "./index";
import vectors from "./testdata/wallet-note-vectors.json";

// Literal current protocol vectors were produced independently of SDK helpers.
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
};
const tokenAddress = BigInt(vectors.context.tokenAddress);
const hex = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;
const note: core.CreditNote = {
    ...context,
    spenderWalletIdentity: ownerHex(BigInt(vectors.credit.spenderWalletIdentity)),
    ownerWalletIdentity: ownerHex(BigInt(vectors.credit.ownerWalletIdentity)),
    spenderPayout: BigInt(vectors.credit.spenderPayout),
    ownerPayout: BigInt(vectors.credit.ownerPayout),
    tokenAddress,
    amount: BigInt(vectors.credit.amount),
    nonce: BigInt(vectors.credit.nonce),
    expiry: BigInt(vectors.credit.expiry),
    creditSharedKey: BigInt(vectors.credit.creditSharedKey),
};
const creditNullifier = vectors.credit.nullifier as `0x${string}`;
const recovery = {
    creditNullifier,
    remainderCommitment: vectors.credit.remainder.remainderCommitment as `0x${string}`,
    recoveryAmount: BigInt(vectors.credit.remainder.recoveryAmount),
};
const remainderAmount = BigInt(vectors.credit.remainder.remainder.amount);
const remainderNonce = BigInt(vectors.credit.remainder.remainder.nonce);
const leaf = async (n: core.CreditNote = note) =>
    core.computeCreditCommitment(
        n.chainId,
        n.spenderWalletIdentity,
        n.ownerWalletIdentity,
        n.spenderPayout,
        n.ownerPayout,
        n.tokenAddress,
        n.amount,
        n.nonce,
        n.expiry,
        await core.computeCreditSharedKeyHash(n.creditSharedKey)
    );

describe("current protocol vectors", () => {
    it("matches independent current ordinary identity, leaf, and nullifier witnesses", async () => {
        const identity = await core.computeNoteIdentity(
            BigInt(vectors.note.walletIdentity),
            BigInt(vectors.note.nonce)
        );
        expect(BigInt(identity)).toBe(BigInt(vectors.note.identity));
        const commitment = await core.computeNoteCommitment(
            context.chainId,
            identity,
            tokenAddress,
            BigInt(vectors.note.amount)
        );
        expect(commitment).toBe(vectors.note.commitment);
        expect(
            await core.computeNoteNullifier(context.chainId, BigInt(vectors.note.nonce), commitment)
        ).toBe(vectors.note.nullifier);
    });

    it("matches the Credit leaf and complete-leaf shared key nullifier", async () => {
        expect(await leaf()).toBe(vectors.credit.commitment);
        expect(
            await core.computeCreditNullifier(
                context.chainId,
                note.creditSharedKey,
                vectors.credit.commitment as `0x${string}`
            )
        ).toBe(creditNullifier);
    });

    it("isolates unrelated owner grants that reuse a shared key", async () => {
        const unrelatedGrant = {
            ...note,
            ownerWalletIdentity: ownerHex(BigInt(note.ownerWalletIdentity) + 1n),
            ownerPayout: note.ownerPayout + 1n,
        };
        expect(
            await core.computeCreditNullifier(
                context.chainId,
                note.creditSharedKey,
                await leaf(unrelatedGrant)
            )
        ).not.toBe(creditNullifier);
    });

    it("binds both wallet roles, both payouts, token, amount, nonce, expiry, chain and shared key", async () => {
        for (const changed of [
            {
                ...note,
                spenderWalletIdentity: ownerHex(BigInt(note.spenderWalletIdentity) + 1n),
                spenderPayout: note.spenderPayout + 1n,
            },
            {
                ...note,
                ownerWalletIdentity: ownerHex(BigInt(note.ownerWalletIdentity) + 1n),
                ownerPayout: note.ownerPayout + 1n,
            },
            { ...note, spenderPayout: note.spenderPayout + 1n },
            { ...note, ownerPayout: note.ownerPayout + 1n },
            { ...note, tokenAddress: note.tokenAddress + 1n },
            { ...note, amount: note.amount + 1n },
            { ...note, nonce: note.nonce + 1n },
            { ...note, expiry: note.expiry + 1n },
            { ...note, chainId: note.chainId + 1n },
            { ...note, creditSharedKey: note.creditSharedKey + 1n },
        ]) {
            if (
                changed.spenderPayout !== BigInt(changed.spenderWalletIdentity) ||
                changed.ownerPayout !== BigInt(changed.ownerWalletIdentity)
            ) {
                await expect(leaf(changed)).rejects.toThrow(/payout/);
                continue;
            }
            const commitment = await leaf(changed);
            expect(commitment).not.toBe(vectors.credit.commitment);
            expect(
                await core.computeCreditNullifier(
                    changed.chainId,
                    changed.creditSharedKey,
                    commitment
                )
            ).not.toBe(creditNullifier);
        }
    });

    it("derives Tag10 remainder nonce and Tag9 recovery pad", async () => {
        expect(
            await core.deriveRemainderNonce(
                context.chainId,
                context.protocolAddress,
                tokenAddress,
                BigInt(creditNullifier),
                note.creditSharedKey
            )
        ).toBe(remainderNonce);
        expect(
            await core.computeCreditRecoveryPad(
                context.chainId,
                context.protocolAddress,
                tokenAddress,
                BigInt(creditNullifier),
                note.creditSharedKey
            )
        ).toBe(recovery.recoveryAmount - remainderAmount);
    });

    it("recovers an authenticated remainder preserving the shared key", async () => {
        expect(await core.recoverCreditRemainder(context, note, recovery)).toEqual({
            ...note,
            amount: remainderAmount,
            nonce: remainderNonce,
        });
    });

    it("accepts full draw only with zero commitment and recovery", async () => {
        expect(
            await core.recoverCreditRemainder(context, note, {
                ...recovery,
                remainderCommitment: hex(0n),
                recoveryAmount: 0n,
            })
        ).toBeNull();
        await expect(
            core.recoverCreditRemainder(context, note, {
                ...recovery,
                remainderCommitment: hex(0n),
            })
        ).rejects.toThrow();
    });

    it("rejects wrong nullifier, tampered commitment, recovery, and deployment context", async () => {
        await expect(
            core.recoverCreditRemainder(context, note, { ...recovery, creditNullifier: hex(1n) })
        ).rejects.toThrow();
        await expect(
            core.recoverCreditRemainder(context, note, {
                ...recovery,
                remainderCommitment: hex(1n),
            })
        ).rejects.toThrow();
        await expect(
            core.recoverCreditRemainder(context, note, {
                ...recovery,
                recoveryAmount: recovery.recoveryAmount + 1n,
            })
        ).rejects.toThrow();
        await expect(
            core.recoverCreditRemainder(
                { ...context, protocolAddress: context.protocolAddress + 1n },
                note,
                recovery
            )
        ).rejects.toThrow();
    });

    it("preserves the note context captured before asynchronous recovery", async () => {
        const mutableNote = { ...note };
        const pending = core.recoverCreditRemainder(context, mutableNote, recovery);
        mutableNote.protocolAddress += 1n;
        mutableNote.ownerPayout += 1n;
        mutableNote.ownerWalletIdentity = hex(1n);
        await expect(pending).resolves.toEqual({
            ...note,
            amount: remainderAmount,
            nonce: remainderNonce,
        });
    });
    it("rejects a mismatched stored note context even for a full draw", async () => {
        for (const wrong of [
            { ...note, chainId: note.chainId + 1n },
            { ...note, protocolAddress: note.protocolAddress + 1n },
        ]) {
            await expect(core.recoverCreditRemainder(context, wrong, recovery)).rejects.toThrow();
            await expect(
                core.recoverCreditRemainder(context, wrong, {
                    ...recovery,
                    remainderCommitment: hex(0n),
                    recoveryAmount: 0n,
                })
            ).rejects.toThrow();
        }
    });
    it("rejects zero, increased, and out-of-range recovered amounts", async () => {
        const pad = recovery.recoveryAmount - remainderAmount;
        for (const amount of [0n, 100n, 101n, 1n << 126n]) {
            await expect(
                core.recoverCreditRemainder(context, note, {
                    ...recovery,
                    recoveryAmount: (pad + amount) % core.FIELD_MODULUS,
                })
            ).rejects.toThrow();
        }
    });

    it("rejects recovery replay against a different grant or payout", async () => {
        for (const changed of [
            { ...note, ownerWalletIdentity: ownerHex(BigInt(note.ownerWalletIdentity) + 1n) },
            { ...note, spenderWalletIdentity: ownerHex(BigInt(note.spenderWalletIdentity) + 1n) },
            { ...note, ownerPayout: note.ownerPayout + 1n },
            { ...note, spenderPayout: note.spenderPayout + 1n },
        ])
            await expect(core.recoverCreditRemainder(context, changed, recovery)).rejects.toThrow();
    });

    it("enforces Credit identity, payout, amount, nonce, expiry and key ranges", async () => {
        for (const changed of [
            { ...note, spenderWalletIdentity: ownerHex(0n) },
            { ...note, ownerWalletIdentity: ownerHex(core.FIELD_MODULUS) },
            { ...note, spenderPayout: 0n },
            { ...note, ownerPayout: 1n << 160n },
            { ...note, amount: 0n },
            { ...note, amount: 1n << 126n },
            { ...note, nonce: core.FIELD_MODULUS },
            { ...note, expiry: 0n },
            { ...note, expiry: 1n << 64n },
            { ...note, chainId: 1n << 64n },
            { ...note, tokenAddress: 1n << 160n },
            { ...note, creditSharedKey: 0n },
            { ...note, creditSharedKey: core.FIELD_MODULUS },
        ])
            await expect(leaf(changed)).rejects.toThrow();
        await expect(
            leaf({
                ...note,
                amount: (1n << 126n) - 1n,
                spenderWalletIdentity: ownerHex((1n << 160n) - 1n),
                ownerWalletIdentity: ownerHex(1n),
                spenderPayout: (1n << 160n) - 1n,
                ownerPayout: 1n,
                expiry: (1n << 64n) - 1n,
                chainId: (1n << 64n) - 1n,
            })
        ).resolves.toMatch(/^0x[0-9a-f]{64}$/);
        for (const key of [-1n, 0n, core.FIELD_MODULUS])
            await expect(
                core.computeCreditNullifier(
                    context.chainId,
                    key,
                    vectors.credit.commitment as `0x${string}`
                )
            ).rejects.toThrow();
        for (const commitment of ["0x01", hex(core.FIELD_MODULUS)])
            await expect(
                core.computeCreditNullifier(
                    context.chainId,
                    note.creditSharedKey,
                    commitment as `0x${string}`
                )
            ).rejects.toThrow();
        await expect(
            core.computeCreditNullifier(
                1n << 64n,
                note.creditSharedKey,
                vectors.credit.commitment as `0x${string}`
            )
        ).rejects.toThrow();
    });

    it("rejects noncanonical recovery and malformed note context", async () => {
        await expect(
            core.recoverCreditRemainder(context, note, {
                ...recovery,
                recoveryAmount: core.FIELD_MODULUS,
            })
        ).rejects.toThrow(RangeError);
        await expect(
            core.recoverCreditRemainder({ ...context, chainId: 1n << 64n }, note, recovery)
        ).rejects.toThrow(RangeError);
        await expect(
            core.recoverCreditRemainder(context, { ...note, expiry: 1n << 64n }, recovery)
        ).rejects.toThrow(RangeError);
        await expect(
            core.recoverCreditRemainder(context, { ...note, creditSharedKey: 0n }, recovery)
        ).rejects.toThrow();
    });
});

function ownerHex(value: string | number | bigint): `0x${string}` {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}
