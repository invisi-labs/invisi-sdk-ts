import {
    computeNoteCommitment,
    computeNoteIdentity,
    encryptPrivateTransferNote,
    fundsV1,
    ViewingCapability,
    viewingPublicKey,
} from "@invisi-labs/core";
import { extractDeliveryCandidates } from "@invisi-labs/sdk/session-support";
import { hexlify, toBeHex } from "ethers";
import { expect, it } from "vitest";
import fmd from "../../../core/src/fmd/testdata/fmd-rust-vectors.json";
import vectors from "../../../core/src/wallet/testdata/wallet-note-vectors.json";
import { decryptCandidates, type DeliveryEventLog } from "../../../sdk/src/index";
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: vectors.context.protocolAddress as `0x${string}`,
};
const token = vectors.context.tokenAddress as `0x${string}`;
const ownerAddress = toBeHex(BigInt(vectors.note.ownerAddress), 20) as `0x${string}`;
const key = Uint8Array.from(Buffer.from(vectors.owner.viewingPrivateKey.slice(2), "hex"));
const clue = fmd.vectors[0]!.clue;
const meta = {
    address: context.protocolAddress,
    blockNumber: 12n,
    blockHash: toBeHex(101n, 32) as `0x${string}`,
    transactionHash: toBeHex(202n, 32) as `0x${string}`,
    logIndex: 1,
    removed: false,
};
function batch(packed: string, commitments: string[]): DeliveryEventLog {
    return {
        ...meta,
        eventName: "BatchOutputs",
        args: {
            tokens: commitments.map(() => token),
            treeId: 1n,
            startLeafIndex: 0,
            noteCommitments: commitments,
            packedDeliveries: packed,
        },
    };
}
it("discovers mixed empty, text and maximum opaque memos at their exact aggregate positions", async () => {
    const commitments: string[] = [];
    const segments: string[] = [];
    const memos = [undefined, "invoice\0paid", new Uint8Array(256).fill(255)];
    for (const [i, memo] of memos.entries()) {
        const note = {
            ...context,
            protocolAddress: BigInt(context.protocolAddress),
            tokenAddress: BigInt(token),
            ownerAddress,
            amount: 70n,
            nonce: BigInt(i + 1),
            payload: fundsV1.encode({
                ...(memo === undefined ? {} : { memo }),
            }),
        };
        const commitment = await computeNoteCommitment(
            note.chainId,
            BigInt(note.protocolAddress),
            await computeNoteIdentity(BigInt(ownerAddress), note.nonce),
            note.tokenAddress,
            note.amount
        );
        commitments.push(commitment);
        const encrypted = await encryptPrivateTransferNote(viewingPublicKey(key), note, {
            ...note,
            outputCommitment: commitment,
        });
        segments.push(toBeHex(encrypted.length, 2).slice(2) + hexlify(encrypted).slice(2) + clue);
    }
    // A contract-valid unknown codec must not hide the three supported outputs in this receipt.
    segments.push("0001" + "7f" + clue);
    commitments.push(toBeHex(1234n, 32));
    const log = batch("0x" + segments.join(""), commitments);
    const inserted: DeliveryEventLog = {
        ...meta,
        logIndex: 0,
        eventName: "CommitmentsInserted",
        args: { treeId: 1n, startLeafIndex: 0, commitments },
    };
    const result = await decryptCandidates([inserted, log], {
        context,
        viewing: new ViewingCapability(ownerAddress, key),
        confirmedThrough: 12n,
    });
    expect(result.notes.map((n) => n.leafIndex)).toEqual([0, 1, 2]);
    expect(fundsV1.decode(result.notes[0]!.note.payload!).memo).toBeUndefined();
    expect(fundsV1.decode(result.notes[1]!.note.payload!).memo).toEqual(
        new TextEncoder().encode("invoice\0paid")
    );
    expect(fundsV1.decode(result.notes[2]!.note.payload!).memo).toEqual(
        new Uint8Array(256).fill(255)
    );
});
it("rejects truncated prefixes, bounds, unsupported versions, truncated clues, trailing bytes and count mismatches", () => {
    const ciphertext = "06" + "00".repeat(160);
    const framed = "00a0" + ciphertext + clue;
    for (const packed of [
        "0x00",
        "0x009f" + ciphertext + clue,
        "0x01a1" + ciphertext + clue,
        "0x00a0" + "01" + ciphertext.slice(2) + clue,
        "0x" + framed.slice(0, -2),
        "0x" + framed + "00",
        "0x" + framed + framed,
    ]) {
        expect(() =>
            extractDeliveryCandidates([batch(packed, [vectors.note.commitment])], context, 12n)
        ).toThrow();
    }
    expect(() =>
        extractDeliveryCandidates(
            [batch("0x" + framed, [vectors.note.commitment, vectors.credit.commitment])],
            context,
            12n
        )
    ).toThrow();
});
