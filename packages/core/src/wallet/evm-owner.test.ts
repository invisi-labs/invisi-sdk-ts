import { describe, expect, it } from "vitest";
import { decodeAddress, encodeLongAddress, encodeShortAddress } from "../address/address";
import { poseidonHash } from "../crypto/poseidon";
import { computeNoteNullifier } from "../notes/nullifier";
import { computeOwnerAddress, deriveWallet } from "./wallet";

const key = "0x" + "01".padStart(64, "0");

describe("EVM owner receipt and authorization", () => {
    it("uses the original account key and EVM address for private spending", async () => {
        const wallet = await deriveWallet(key);
        expect(wallet.ownerAddress).toBe("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
        expect(Array.from(wallet.spendingPrivateKey)).toEqual(
            Array.from(Buffer.from(key.slice(2), "hex"))
        );
        expect(await computeOwnerAddress(wallet.spendingPublicKey)).toBe(wallet.ownerAddress);
        expect(wallet).not.toHaveProperty("nullifierKey");
    });

    it("encodes one 20-byte owner in both address forms", async () => {
        const wallet = await deriveWallet(key);
        const long = encodeLongAddress(wallet);
        const short = encodeShortAddress(wallet.ownerAddress);
        expect(long).toHaveLength(138);
        expect(short).toHaveLength(42);
        expect(short).toBe("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf");
        expect(decodeAddress(long).ownerAddress).toBe(wallet.ownerAddress);
        expect(decodeAddress(short).ownerAddress).toBe(wallet.ownerAddress);
        expect(() => encodeShortAddress(("0x" + "01".repeat(32)) as `0x${string}`)).toThrow();
    });

    it("fixes a nullifier using the note opening instead of a selectable wallet secret", async () => {
        const commitment = ("0x" + "02".repeat(32)) as `0x${string}`;
        expect(await computeNoteNullifier(31337n, 0n, commitment)).toBe(
            await poseidonHash([4n, 31337n, 0n, BigInt(commitment)])
        );
    });
});
