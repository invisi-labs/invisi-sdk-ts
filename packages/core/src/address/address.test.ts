import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it, vi } from "vitest";
import { FIELD_MODULUS } from "../crypto/random";
import { decodeAddress, encodeLongAddress, encodeShortAddress, resolveAddress } from "./address";

// Frozen specification example, decoded independently with a Python bitstream.
const recipient = {
    ownerAddress: "0x0123456789abcdef0123456789abcdef01234567" as const,
    viewingPublicKey: hexToBytes(
        "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    ),
    clueKey: hexToBytes("5e76af9c7426fac4d98fab8a535aed01604b29fdcf458c5f657a19828e196412"),
};
const long =
    "0iqY352Euf40X77QFrG4NcN27DaUqJX3t8QfUMUEn7l8wtHtz45p3FTN58pvRs9XlumvKUu2Xet8EgZkCklQTeShnK47w8gFh6cNvcL2u22ddW6QTqfV5Lmn69330k27sES28pJeqj";
const short = "0x0123456789abcDEF0123456789abCDef01234567";

describe("Invisi address encoding", () => {
    it("matches exact specification bytes, character lengths and case checksums", () => {
        expect(encodeLongAddress(recipient)).toBe(long);
        expect(encodeShortAddress(recipient.ownerAddress)).toBe(short);
        expect(long.length).toBe(138);
        expect(short.length).toBe(42);
        expect(decodeAddress(long)).toEqual({ kind: "long", ...recipient });
        expect(decodeAddress(short)).toEqual({
            kind: "short",
            ownerAddress: recipient.ownerAddress,
        });
    });

    it("rejects long-address corruption and noncanonical case", () => {
        for (let i = 2; i < long.length; i++) {
            const replacement = long[i]!.toLowerCase() === "q" ? "p" : "q";
            expect(() =>
                decodeAddress(long.slice(0, i) + replacement + long.slice(i + 1))
            ).toThrow();
        }
        expect(() => decodeAddress(long.toLowerCase())).toThrow(/checksum/);
        expect(() => decodeAddress("0i" + long.slice(2).toUpperCase())).toThrow(/checksum/);
        expect(() => decodeAddress(long + "q")).toThrow(/length/);
        expect(() => decodeAddress(long.slice(1))).toThrow(/prefix/);
    });

    it("accepts standard EVM short addresses and rejects malformed or bad mixed-case addresses", () => {
        for (const text of [short, short.toLowerCase(), "0x" + short.slice(2).toUpperCase()]) {
            expect(decodeAddress(text)).toEqual({
                kind: "short",
                ownerAddress: recipient.ownerAddress,
            });
            expect(encodeShortAddress(text as `0x${string}`)).toBe(short);
        }
        const wrongCase = short.replace("a", "A");
        expect(wrongCase).not.toBe(short);
        expect(() => decodeAddress(wrongCase)).toThrow(/checksum/);
        expect(() => decodeAddress(short + "0")).toThrow();
        expect(() => decodeAddress("0x" + "00".repeat(20))).toThrow();
        expect(() => decodeAddress("0x" + "gg".repeat(20))).toThrow();
    });

    it("rejects retired address encodings", () => {
        expect(() => decodeAddress("0iQy352EUf40X77qfRG4NCn27DAUQjX3t8")).toThrow();
        expect(() => decodeAddress("0inv" + long.slice(2))).toThrow();
    });

    it("rejects noncanonical identities, malformed secp keys and invalid clue keys", () => {
        for (const identity of [0n, -1n, FIELD_MODULUS])
            expect(() => encodeShortAddress(identity)).toThrow(/owner address/);
        expect(() =>
            encodeLongAddress({ ...recipient, viewingPublicKey: new Uint8Array(33) })
        ).toThrow(/viewing/);
        const invalidSecp = hexToBytes("02" + "ff".repeat(32));
        expect(() => encodeLongAddress({ ...recipient, viewingPublicKey: invalidSecp })).toThrow();
        expect(() => encodeLongAddress({ ...recipient, clueKey: new Uint8Array(32) })).toThrow();
        expect(() =>
            encodeLongAddress({ ...recipient, clueKey: new Uint8Array(32).fill(255) })
        ).toThrow();
    });

    it("resolves a long address offline and a short address through its explicit registry lookup", async () => {
        const lookup = vi.fn(async () => ({
            viewingPublicKey: recipient.viewingPublicKey,
            clueKey: recipient.clueKey,
        }));
        expect(await resolveAddress(long, { lookup })).toEqual(recipient);
        expect(lookup).not.toHaveBeenCalled();
        expect(await resolveAddress(short, { lookup })).toEqual(recipient);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(lookup).toHaveBeenCalledWith(recipient.ownerAddress);
        await expect(resolveAddress(short)).rejects.toThrow(/lookup/);
        await expect(resolveAddress(short, { lookup: async () => null })).rejects.toThrow(
            /registered/
        );
        await expect(
            resolveAddress(short, {
                lookup: async () => {
                    throw new Error("registry unavailable");
                },
            })
        ).rejects.toThrow(/registry unavailable/);
        const result = await resolveAddress(short, { lookup });
        result.clueKey[0] = result.clueKey[0]! ^ 1;
        expect(bytesToHex(recipient.clueKey)).toBe(
            "5e76af9c7426fac4d98fab8a535aed01604b29fdcf458c5f657a19828e196412"
        );
    });
});
