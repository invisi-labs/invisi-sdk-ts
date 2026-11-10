import { expect, it } from "vitest";
import { fundsEnvelopeV1 } from "./note-payload";
const context = {
    chainId: 97n,
    protocolAddress: 1n,
    tokenAddress: 2n,
    ownerAddress: "0x0000000000000000000000000000000000000003" as const,
    outputCommitment: "0x01" as `0x${string}`,
};
const note = { ...context, amount: 1n, nonce: 4n };
it("frames opaque bytes by their complete length, including empty and unknown application formats", () => {
    for (const payload of [new Uint8Array(), new Uint8Array([255, 99, 0]), new Uint8Array(3936)]) {
        const encoded = fundsEnvelopeV1.encode({ ...note, payload });
        expect(Array.from(encoded.slice(80, 82))).toEqual([
            payload.length >> 8,
            payload.length & 255,
        ]);
        expect(fundsEnvelopeV1.decode(encoded, context).payload).toEqual(payload);
    }
});
it("rejects truncated length prefixes, mismatched lengths and trailing data", () => {
    const prefix = fundsEnvelopeV1.encode(note).slice(0, 80);
    for (const metadata of [[], [0], [0, 1], [0, 0, 1], [0, 2, 1], [255, 255]]) {
        expect(() =>
            fundsEnvelopeV1.decode(new Uint8Array([...prefix, ...metadata]), context)
        ).toThrow();
    }
});
