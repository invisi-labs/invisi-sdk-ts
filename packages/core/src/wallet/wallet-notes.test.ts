import { describe, expect, it } from "vitest";
import { decryptCreditState, decryptPrivateTransferNote } from "../delivery/encryption";
import { computeNoteCommitment, computeNoteIdentity } from "../notes/commitment";
import {
    applyCreditDrawUsage,
    computeCreditCommitment,
    computeCreditNullifier,
    computeCreditSharedKeyHash,
    recoverCreditState,
} from "../credit/state";
import { computeNoteNullifier } from "../notes/nullifier";
import type { CreditState, Note } from "../types";
import vectors from "./testdata/wallet-note-vectors.json";
const hexToBytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text.slice(2), "hex"));
const hex = (value: string): `0x${string}` => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
};
const note: Note = {
    ...context,
    ownerAddress: ownerHex(vectors.note.ownerAddress),
    tokenAddress: BigInt(vectors.context.tokenAddress),
    amount: 70n,
    nonce: 123n,
};
const credit: CreditState = {
    ...context,
    tokenAddress: note.tokenAddress,
    spenderWalletIdentity: ownerHex(vectors.credit.spenderWalletIdentity),
    ownerWalletIdentity: note.ownerAddress,
    revocationShard: 1n,
    revocationSlot: 0n,
    nonce: 678n,
    expiry: 2000000123n,
    creditSharedKey: 999n,
    singleLimit: BigInt(vectors.credit.singleLimit),
    dailyLimit: BigInt(vectors.credit.dailyLimit),
    monthlyLimit: BigInt(vectors.credit.monthlyLimit),
    availableCredit: BigInt(vectors.credit.availableCredit),
    unlimited: vectors.credit.unlimited,
    lastDay: BigInt(vectors.credit.lastDay),
    dailySpent: BigInt(vectors.credit.dailySpent),
    lastMonth: BigInt(vectors.credit.lastMonth),
    monthlySpent: BigInt(vectors.credit.monthlySpent),
    totalSpent: BigInt(vectors.credit.totalSpent),
};
const creditLeaf = (n: CreditState) => computeCreditCommitment(n);

describe("wallet-owned note vectors", () => {
    it("matches genuine current protocol identity, leaf and private-key nullifier", async () => {
        const identity = await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce);
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

    it("binds both Credit roles and policy through the complete leaf and shared nullifier", async () => {
        const commitment = await creditLeaf(credit);
        expect(commitment).toBe(vectors.credit.commitment);
        expect(
            await computeCreditNullifier(credit.chainId, credit.creditSharedKey, commitment)
        ).toBe(vectors.credit.nullifier);
        const alternate = {
            ...credit,
            ownerWalletIdentity: credit.spenderWalletIdentity,
        };
        expect(
            await computeCreditNullifier(
                credit.chainId,
                credit.creditSharedKey,
                await creditLeaf(alternate)
            )
        ).not.toBe(vectors.credit.nullifier);
    });

    it("recovers authenticated Credit successors with preserved roles and policy", async () => {
        const r = vectors.credit.draw;
        const recovered = await recoverCreditState(context, credit, {
            timestamp: BigInt(vectors.context.timestamp),
            creditNullifier: r.nullifier as `0x${string}`,
            stateCommitment: r.stateCommitment as `0x${string}`,
            recoveryAmount: BigInt(r.recoveryAmount),
        });
        expect(recovered).toEqual({
            ...credit,
            ...applyCreditDrawUsage(credit, 30n, BigInt(vectors.context.timestamp)),
            nonce: BigInt(r.state.nonce),
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
                ownerAddress: note.ownerAddress,
            }
        );
        expect(recovered).toEqual({ ...note, payload: new Uint8Array() });
        for (const role of ["owner", "spender"] as const) {
            expect(
                await decryptCreditState(
                    vectors[role].viewingPrivateKey as `0x${string}`,
                    vectors.credit[
                        role === "owner" ? "ownerCiphertext" : "spenderCiphertext"
                    ] as `0x${string}`,
                    {
                        ...context,
                        tokenAddress: note.tokenAddress,
                        outputCommitment: vectors.credit.commitment as `0x${string}`,
                        ownerAddress: ownerHex(vectors[role].ownerAddress),
                        role,
                    }
                )
            ).toEqual({
                note: { ...credit, payload: new Uint8Array() },
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
