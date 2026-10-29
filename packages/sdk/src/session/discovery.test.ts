import type { Hex } from "@invisi-labs/protocol/contracts";
import { toBeHex } from "ethers";

import { ViewingCapability } from "@invisi-labs/core";
import { expect, it } from "vitest";
import fmd from "../../../core/src/testdata/fmd-rust-vectors.json";
import vectors from "../../../core/src/testdata/wallet-note-vectors.json";
import { decryptCandidates, extractDeliveryCandidates, type DeliveryEventLog } from "./discovery";
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: vectors.context.protocolAddress as `0x${string}`,
    tokenAddress: vectors.context.tokenAddress as `0x${string}`,
};
const walletIdentity = toBeHex(BigInt(vectors.owner.walletIdentity), 20) as Hex;
const clue = ("0x" + fmd.vectors[0]!.clue) as `0x${string}`;
const delivery = { ciphertext: vectors.note.ciphertext as `0x${string}`, clue };
const meta = {
    address: context.protocolAddress,
    blockNumber: 12n,
    blockHash: toBeHex(101n, 32) as Hex,
    transactionHash: toBeHex(202n, 32) as Hex,
    logIndex: 1,
    removed: false,
};
const inserted = (
    commitments = [vectors.note.commitment],
    treeId = 1n,
    startLeafIndex = 0
): DeliveryEventLog => ({
    ...meta,
    eventName: "CommitmentsInserted",
    args: { treeId, startLeafIndex, commitments },
});
const shield = (): DeliveryEventLog => ({
    ...meta,
    logIndex: 2,
    eventName: "Shield",
    args: { token: context.tokenAddress, treeId: 1n, startLeafIndex: 0, deliveries: [delivery] },
});
const viewing = () =>
    new ViewingCapability(walletIdentity, vectors.owner.viewingPrivateKey as `0x${string}`);
const decrypt = (logs: readonly DeliveryEventLog[], confirmedThrough = 12n) =>
    decryptCandidates(logs, { context, viewing: viewing(), confirmedThrough });
it("recovers authenticated local notes without retaining inventory or mutating input", async () => {
    const batch = [inserted(), shield()];
    const before = structuredClone(batch);
    const result = await decrypt(batch);
    expect(result.notes).toMatchObject([
        { note: { amount: 70n, walletIdentity }, treeId: 1n, leafIndex: 0 },
    ]);
    expect(result.credits).toEqual([]);
    result.notes[0]!.note.amount = 900n;
    expect((await decrypt(batch)).notes[0]!.note.amount).toBe(70n);
    expect(batch).toEqual(before);
    await expect(decrypt(batch, 11n)).rejects.toThrow(/confirmed/i);
    await expect(decrypt([shield()])).rejects.toThrow(/insertion/i);
});
it("authenticates a payment despite a malformed detection clue", async () => {
    const bad = shield();
    bad.args = {
        ...bad.args,
        deliveries: [
            { ...delivery, clue: ("0x" + "00".repeat(64) + "18" + "00".repeat(3)) as Hex },
        ],
    };
    expect((await decrypt([inserted(), bad])).notes).toHaveLength(1);
});
it("rejects malformed batches and removed logs without retaining failed state", async () => {
    const malformed = {
        ...shield(),
        logIndex: 3,
        args: {
            token: context.tokenAddress,
            treeId: 1n,
            startLeafIndex: 1,
            deliveries: [delivery],
        },
    };
    await expect(decrypt([inserted(), shield(), malformed])).rejects.toThrow(/insertion/i);
    await expect(decrypt([{ ...inserted(), removed: true }])).rejects.toThrow(/reorg/i);
    expect((await decrypt([inserted(), shield()])).notes).toHaveLength(1);
});
it("maps packed aggregate segments and Credit owner/spender slots without treating public refunds as notes", async () => {
    const packed =
        toBeHex((delivery.ciphertext.length - 2) / 2, 2) +
        delivery.ciphertext.slice(2) +
        clue.slice(2);
    const aggregate = {
        ...meta,
        eventName: "BatchOutputs",
        args: {
            tokens: [vectors.note.commitment].map(() => context.tokenAddress),
            treeId: 2n,
            startLeafIndex: 7,
            firstOutputOffset: 99n,
            commitments: [vectors.note.commitment],
            packedDeliveries: packed,
        },
    };
    expect(extractDeliveryCandidates([aggregate], context, 12n)).toMatchObject([
        { treeId: 2n, leafIndex: 7, role: "funds" },
    ]);
    const cd = { ciphertext: vectors.credit.ownerCiphertext as `0x${string}`, clue };
    const created: DeliveryEventLog = {
        ...meta,
        logIndex: 2,
        eventName: "CreditCreated",
        args: {
            token: context.tokenAddress,
            outputTreeId: 1n,
            creditCommitment: vectors.credit.commitment,
            changeCommitment: toBeHex(0n, 32) as Hex,
            leafIndices: [0],
            deliveries: [
                cd,
                { ...cd, ciphertext: vectors.credit.spenderCiphertext },
                { ciphertext: "0x", clue: "0x" },
            ],
        },
    };
    const result = await decrypt([inserted([vectors.credit.commitment]), created]);
    expect(result.notes).toEqual([]);
    expect(result.credits).toMatchObject([
        {
            role: "owner",
            state: {
                note: {
                    amount: 100n,
                    ownerWalletIdentity: walletIdentity,
                    ownerPayout: BigInt(vectors.credit.ownerPayout),
                },
            },
        },
    ]);
    const cancelled = {
        ...meta,
        eventName: "CreditCancelled",
        args: { amount: 100n, owner: context.protocolAddress },
    };
    expect(await decrypt([cancelled])).toEqual({ notes: [], credits: [] });
});
it("uses exact direct, cross-tree, top-up and partial/full draw output layouts", () => {
    const args = {
        token: context.tokenAddress,
        outputTreeId: 1n,
        outputCommitments: [vectors.note.commitment],
        leafIndices: [0],
        deliveries: [delivery],
    };
    for (const eventName of ["Transact", "CrossTreeTransact"]) {
        expect(
            extractDeliveryCandidates(
                [inserted(), { ...meta, logIndex: 2, eventName, args }],
                context,
                12n
            )
        ).toHaveLength(1);
    }
    const creditDelivery = { ciphertext: vectors.credit.ownerCiphertext, clue };
    const creation = {
        token: context.tokenAddress,
        creditCommitment: vectors.credit.commitment,
        changeCommitment: toBeHex(0n, 32) as Hex,
    };
    const topUp = {
        ...meta,
        logIndex: 2,
        eventName: "CreditToppedUp",
        args: {
            outputTreeId: 1n,
            params: { creation },
            leafIndices: [0],
            deliveries: [creditDelivery, creditDelivery, { ciphertext: "0x", clue: "0x" }],
        },
    };
    expect(
        extractDeliveryCandidates([inserted([vectors.credit.commitment]), topUp], context, 12n).map(
            (c) => c.role
        )
    ).toEqual(["owner", "spender"]);
    const partial = {
        ...meta,
        logIndex: 2,
        eventName: "CreditDraw",
        args: {
            outputTreeId: 1n,
            params: {
                token: context.tokenAddress,
                remainderCommitments: [vectors.credit.commitment],
            },
            remainderLeafIndices: [0],
            deliveries: [creditDelivery, creditDelivery],
        },
    };
    expect(
        extractDeliveryCandidates([inserted([vectors.credit.commitment]), partial], context, 12n)
    ).toHaveLength(2);
    const full = {
        ...meta,
        logIndex: 2,
        eventName: "CreditDraw",
        args: {
            outputTreeId: 0n,
            params: {
                token: context.tokenAddress,
                remainderCommitments: [toBeHex(0n, 32) as Hex],
            },
            remainderLeafIndices: [0],
            deliveries: [
                { ciphertext: "0x", clue: "0x" },
                { ciphertext: "0x", clue: "0x" },
            ],
        },
    };
    expect(extractDeliveryCandidates([full], context, 12n)).toEqual([]);
    expect(() =>
        extractDeliveryCandidates(
            [
                {
                    ...full,
                    args: {
                        token: context.tokenAddress,
                        ...full.args,
                        deliveries: [creditDelivery, creditDelivery],
                    },
                },
            ],
            context,
            12n
        )
    ).toThrow();
    const wrong = { ...args, outputCommitments: [toBeHex(1n, 32) as Hex] };
    expect(() =>
        extractDeliveryCandidates(
            [inserted(), { ...meta, eventName: "Transact", args: wrong }],
            context,
            12n
        )
    ).toThrow(/insertion/i);
});
it("skips redirected ciphertexts and unrelated addresses, with independent concurrent calls", async () => {
    const batch = [inserted(), shield()];
    const other = await decryptCandidates(batch, {
        context,
        confirmedThrough: 12n,
        viewing: new ViewingCapability(
            toBeHex(BigInt(vectors.spender.walletIdentity), 20) as Hex,
            vectors.spender.viewingPrivateKey as Hex
        ),
    });
    expect(other).toEqual({ notes: [], credits: [] });
    const results = await Promise.all([decrypt(batch), decrypt(batch)]);
    expect(results.map((result) => result.notes.length)).toEqual([1, 1]);
    expect(
        await decrypt(
            batch.map((log) => ({ ...log, address: "0x1111111111111111111111111111111111111111" }))
        )
    ).toEqual({ notes: [], credits: [] });
});
it("deduplicates repeated candidates and rejects conflicting positions across receipts", async () => {
    expect((await decrypt([inserted(), shield(), inserted(), shield()])).notes).toHaveLength(1);
    const conflicting = [inserted(), shield()].map((log) => ({
        ...log,
        transactionHash: toBeHex(203n, 32) as Hex,
    }));
    await expect(decrypt([inserted(), shield(), ...conflicting])).rejects.toThrow(
        /canonical position/i
    );
});

it("binds decryption to the Credit delivery role", async () => {
    const created: DeliveryEventLog = {
        ...meta,
        eventName: "CreditCreated",
        logIndex: 2,
        args: {
            token: context.tokenAddress,
            outputTreeId: 1n,
            creditCommitment: vectors.credit.commitment,
            changeCommitment: toBeHex(0n, 32),
            leafIndices: [0],
            deliveries: [
                { ciphertext: vectors.credit.spenderCiphertext, clue },
                { ciphertext: vectors.credit.ownerCiphertext, clue },
                { ciphertext: "0x", clue: "0x" },
            ],
        },
    };
    expect(await decrypt([inserted([vectors.credit.commitment]), created])).toEqual({
        notes: [],
        credits: [],
    });
});
