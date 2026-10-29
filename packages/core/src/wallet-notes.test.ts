import { describe, it, expect } from "vitest";
import vectors from "./testdata/wallet-note-vectors.json";
import { computeNoteIdentity, computeNoteCommitment } from "./commitment";
import { computeNoteNullifier } from "./nullifier";
import {
    computeCreditCommitment,
    applyCreditDrawUsage,
    computeCreditSharedKeyHash,
    computeCreditNullifier,
    recoverCreditRemainder,
} from "./creditCommitment";
import { decryptPrivateTransferNote, decryptCreditNote } from "./encryption";
const hexToBytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text.slice(2), "hex"));
import type { Note, CreditNote } from "./types";
const hex = (value: string): `0x${string}` => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
};
const note: Note = {
    ...context,
    walletIdentity: ownerHex(vectors.note.walletIdentity),
    tokenAddress: BigInt(vectors.context.tokenAddress),
    amount: 70n,
    nonce: 123n,
};
const credit: CreditNote = {
    ...context,
    tokenAddress: note.tokenAddress,
    spenderWalletIdentity: ownerHex(vectors.credit.spenderWalletIdentity),
    ownerWalletIdentity: note.walletIdentity,
    spenderPayout: BigInt(vectors.credit.spenderWalletIdentity),
    ownerPayout: BigInt(vectors.credit.ownerWalletIdentity),
    amount: 100n,
    nonce: 678n,
    expiry: 2000000123n,
    creditSharedKey: 999n,
    singleLimit: BigInt(vectors.credit.singleLimit),
    dailyLimit: BigInt(vectors.credit.dailyLimit),
    monthlyLimit: BigInt(vectors.credit.monthlyLimit),
    lastDay: BigInt(vectors.credit.lastDay),
    dailySpent: BigInt(vectors.credit.dailySpent),
    lastMonth: BigInt(vectors.credit.lastMonth),
    monthlySpent: BigInt(vectors.credit.monthlySpent),
};
const creditLeaf = (n: CreditNote) =>
    computeCreditSharedKeyHash(n.creditSharedKey).then((keyHash) =>
        computeCreditCommitment(
            n.chainId,
            n.spenderWalletIdentity,
            n.ownerWalletIdentity,
            n.spenderPayout,
            n.ownerPayout,
            n.tokenAddress,
            n.amount,
            n.nonce,
            n.expiry,
            keyHash,
            n
        )
    );

describe("wallet-owned note vectors", () => {
    it("matches genuine current protocol identity, leaf and private-key nullifier", async () => {
        const identity = await computeNoteIdentity(BigInt(note.walletIdentity), note.nonce);
        expect(BigInt(identity)).toBe(BigInt(vectors.note.identity));
        const commitment = await computeNoteCommitment(
            note.chainId,
            identity,
            note.tokenAddress,
            note.amount
        );
        expect(commitment).toBe(vectors.note.commitment);
        expect(
            await computeNoteNullifier(note.chainId, BigInt(vectors.note.nonce), commitment)
        ).toBe(vectors.note.nullifier);
    });

    it("binds both Credit roles and public payouts through the complete leaf and shared nullifier", async () => {
        const commitment = await creditLeaf(credit);
        expect(commitment).toBe(vectors.credit.commitment);
        expect(
            await computeCreditNullifier(credit.chainId, credit.creditSharedKey, commitment)
        ).toBe(vectors.credit.nullifier);
        const alternate = {
            ...credit,
            ownerWalletIdentity: credit.spenderWalletIdentity,
            ownerPayout: BigInt(credit.spenderWalletIdentity),
        };
        expect(
            await computeCreditNullifier(
                credit.chainId,
                credit.creditSharedKey,
                await creditLeaf(alternate)
            )
        ).not.toBe(vectors.credit.nullifier);
    });

    it("recovers the authenticated remainder without changing wallet roles or payout addresses", async () => {
        const r = vectors.credit.remainder;
        const recovered = await recoverCreditRemainder(context, credit, {
            timestamp: BigInt(vectors.context.timestamp),
            creditNullifier: r.nullifier as `0x${string}`,
            remainderCommitment: r.remainderCommitment as `0x${string}`,
            recoveryAmount: BigInt(r.recoveryAmount),
        });
        expect(recovered).toEqual({
            ...credit,
            ...applyCreditDrawUsage(credit, 30n, BigInt(vectors.context.timestamp)),
            amount: 70n,
            nonce: BigInt(r.remainder!.nonce),
        });
    });

    it("opens independent Nodecrypto funds and both role-bound Credit envelopes", async () => {
        const recovered = await decryptPrivateTransferNote(
            vectors.owner.viewingPrivateKey as `0x${string}`,
            vectors.note.ciphertext as `0x${string}`,
            {
                ...context,
                tokenAddress: note.tokenAddress,
                outputCommitment: vectors.note.commitment as `0x${string}`,
                walletIdentity: note.walletIdentity,
            }
        );
        expect(recovered).toEqual(note);
        for (const role of ["owner", "spender"] as const) {
            expect(
                await decryptCreditNote(
                    vectors[role].viewingPrivateKey as `0x${string}`,
                    vectors.credit[
                        role === "owner" ? "ownerCiphertext" : "spenderCiphertext"
                    ] as `0x${string}`,
                    {
                        ...context,
                        tokenAddress: note.tokenAddress,
                        outputCommitment: vectors.credit.commitment as `0x${string}`,
                        walletIdentity: ownerHex(vectors[role].walletIdentity),
                        role,
                    }
                )
            ).toEqual({
                note: credit,
                ...Object.fromEntries(
                    ["owner", "spender"].map((role) => {
                        const keys =
                            vectors.credit[
                                `${role}ReceivingKeys` as
                                    "ownerReceivingKeys" | "spenderReceivingKeys"
                            ];
                        return [
                            `${role}ReceivingKeys`,
                            {
                                viewingPublicKey: hexToBytes(
                                    keys.viewingPublicKey as `0x${string}`
                                ),
                                clueKey: hexToBytes(keys.clueKey as `0x${string}`),
                            },
                        ];
                    })
                ),
            });
        }
    });
});

function ownerHex(value: string | number | bigint): `0x${string}` {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}
