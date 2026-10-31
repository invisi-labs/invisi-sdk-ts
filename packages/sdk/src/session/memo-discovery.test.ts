import { expect, it } from "vitest";
import { hexlify, toBeHex } from "ethers";
import {
    computeNoteCommitment,
    computeNoteIdentity,
    encryptPrivateTransferNote,
    ViewingCapability,
    ReceivingAddress,
    viewingPublicKey,
} from "@invisi-labs/core";
import vectors from "../../../core/src/testdata/wallet-note-vectors.json";
import fmd from "../../../core/src/testdata/fmd-rust-vectors.json";
import { decryptCandidates, type DeliveryEventLog } from "../index";
import { extractDeliveryCandidates } from "./discovery";
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: vectors.context.protocolAddress as `0x${string}`,
};
const token = vectors.context.tokenAddress as `0x${string}`;
const walletIdentity = toBeHex(BigInt(vectors.note.walletIdentity), 20) as `0x${string}`;
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
            commitments,
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
            walletIdentity,
            amount: 70n,
            nonce: BigInt(i + 1),
            ...(i === 2
                ? {
                      returnAddress: ReceivingAddress.from({
                          walletIdentity,
                          viewingPublicKey: viewingPublicKey(key),
                          clueKey: Uint8Array.from(
                              Buffer.from(vectors.credit.ownerReceivingKeys.clueKey.slice(2), "hex")
                          ),
                      }).toString(),
                  }
                : {}),
            ...(memo === undefined ? {} : { memo }),
        };
        const commitment = await computeNoteCommitment(
            note.chainId,
            await computeNoteIdentity(BigInt(walletIdentity), note.nonce),
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
        viewing: new ViewingCapability(walletIdentity, key),
        confirmedThrough: 12n,
    });
    expect(result.notes.map((n) => n.leafIndex)).toEqual([0, 1, 2]);
    expect(result.notes[0]!.note).not.toHaveProperty("memo");
    expect(result.notes[0]!.note).not.toHaveProperty("returnAddress");
    expect(result.notes[2]!.note.returnAddress).toMatch(/^0i/);
    expect(result.notes[1]!.note.memo).toEqual(new TextEncoder().encode("invoice\0paid"));
    expect(result.notes[2]!.note.memo).toEqual(new Uint8Array(256).fill(255));
});
it("rejects truncated prefixes, bounds, old versions, truncated clues, trailing bytes and count mismatches", () => {
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
