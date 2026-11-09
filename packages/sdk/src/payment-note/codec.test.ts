import { expect, it } from "vitest";
import { FIELD_MODULUS, computeNoteIdentity, computeNoteCommitment } from "@invisi-labs/core";
import { encodePaymentNote, decodePaymentNote } from "./codec";
import { PaymentNote } from "./PaymentNote";
const address = "0x1111111111111111111111111111111111111111" as const;
const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as const;
const data = {
    chainId: 97n,
    protocolAddress: address,
    tokenAddress: address,
    amount: 70n,
    ownerAddress: address,
    nonce: 0n,
    commitment: hex(1n),
};
it("encodes a fixed 149-byte Note with no payload and canonical Base64URL", () => {
    const encoded = encodePaymentNote(data);
    expect(encoded).toHaveLength(203);
    expect(encoded.startsWith("ipn:")).toBe(true);
    expect(decodePaymentNote(encoded)).toEqual(data);
    for (const value of [
        encoded + "=",
        encoded + "A",
        encoded.slice(0, -1),
        "ipr:" + encoded.slice(4),
    ])
        expect(() => decodePaymentNote(value)).toThrow();
    expect(() => encodePaymentNote({ ...data, payload: new Uint8Array() } as any)).toThrow();
    for (const value of [
        { ...data, amount: 0n },
        { ...data, nonce: FIELD_MODULUS },
        { ...data, chainId: 1n << 64n },
        { ...data, commitment: hex(0n) },
    ])
        expect(() => encodePaymentNote(value)).toThrow();
});
it("validates commitment preimages before exposing a PaymentNote", async () => {
    const identity = await computeNoteIdentity(BigInt(address), data.nonce);
    const commitment = await computeNoteCommitment(
        data.chainId,
        BigInt(data.protocolAddress),
        identity,
        BigInt(address),
        data.amount
    );
    const original = { ...data, commitment };
    const note = await PaymentNote.from(encodePaymentNote(original));
    expect(note.amount).toBe(70n);
    expect(note.ipn).toBe(encodePaymentNote(original));
    await expect(PaymentNote.from(encodePaymentNote({ ...original, amount: 71n }))).rejects.toThrow(
        /commitment/
    );
});
