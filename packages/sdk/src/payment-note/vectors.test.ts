import { expect, it } from "vitest";
import { decodeBase64, hexlify } from "ethers";
import vectors from "./testdata/notes.json";
import { encodePaymentNote, decodePaymentNote } from "./codec";
import { PaymentNote } from "./PaymentNote";
import type { PaymentNoteData } from "./types";
for (const vector of vectors) {
    it(`matches independently encoded ${vector.name}`, async () => {
        const data = {
            ...vector.note,
            chainId: BigInt(vector.note.chainId),
            amount: BigInt(vector.note.amount),
            nonce: BigInt(vector.note.nonce),
        } as PaymentNoteData;
        expect(encodePaymentNote(data)).toBe(vector.encoded);
        expect(decodePaymentNote(vector.encoded)).toEqual(data);
        expect(
            hexlify(
                decodeBase64(vector.encoded.slice(4).replace(/-/g, "+").replace(/_/g, "/") + "=")
            )
        ).toBe(`0x${vector.binaryHex}`);
        expect((await PaymentNote.from(vector.encoded)).commitment).toBe(data.commitment);
    });
}
it("rejects nonzero unused bits and unknown versions", () => {
    const encoded = vectors[0]!.encoded;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const index = alphabet.indexOf(encoded.at(-1)!);
    expect(() => decodePaymentNote(encoded.slice(0, -1) + alphabet[index | 1])).toThrow(
        /canonical/
    );
    expect(() => decodePaymentNote(encoded.slice(0, 4) + "Ag" + encoded.slice(6))).toThrow();
});
