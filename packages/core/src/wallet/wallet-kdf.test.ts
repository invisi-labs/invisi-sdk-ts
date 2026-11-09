import { LocalWallet } from "./local-wallet";
import { secp256k1 } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { describe, expect, it } from "vitest";
import { signWalletAuthorization, verifyWalletAuthorization } from "../index";
import vectors from "./testdata/wallet-kdf-vectors.json";
import { deriveWallet } from "./wallet";

const request = {
    context: { chainId: 31337n, protocolAddress: 0x1234n },
    operation: "transact" as const,
    capacity: 2,
    words: [31337n, 0x1234n],
};

describe("EVM account key restoration", () => {
    it("matches independent HKDF vectors and uses the same EVM signing key and separate viewing/detection keys", async () => {
        for (const row of vectors.vectors) {
            const wallet = await deriveWallet(row.privateKey);
            for (const name of [
                "spendingPrivateKey",
                "viewingPrivateKey",
                "detectionSeed",
                "detectionKey",
            ] as const) {
                expect(bytesToHex(wallet[name])).toBe(row[name]);
            }
            expect(bytesToHex(wallet.spendingPrivateKey)).toBe(row.privateKey.slice(2));
            expect(bytesToHex(wallet.spendingPrivateKey)).not.toBe(
                bytesToHex(wallet.viewingPrivateKey)
            );
        }
    });

    it("restores all capabilities from hex or bytes without retaining or mutating caller keys", async () => {
        const row = vectors.vectors[0]!;
        const input = hexToBytes(row.privateKey.slice(2));
        const before = input.slice();
        const wallet = await LocalWallet.fromPrivateKey(input);
        const restore: (privateKey: string | Uint8Array) => Promise<LocalWallet> =
            LocalWallet.fromPrivateKey;
        const restored = await restore(row.privateKey);
        expect(wallet.getAddress()).toBe(restored.getAddress());
        expect(wallet.ownerAddress).toBe(restored.ownerAddress);
        expect(wallet.getViewer().getPublicKey()).toEqual(restored.getViewer().getPublicKey());
        expect(wallet.getDetector().exportKey()).toEqual(restored.getDetector().exportKey());
        expect(input).toEqual(before);
        input.fill(0);
        const authorized = await wallet.exportAuthorization().authorize(request);
        const witness = authorized.withWitness((value) => value);
        const publicKey = secp256k1.getPublicKey(hexToBytes(row.spendingPrivateKey), false);
        expect(
            await verifyWalletAuthorization(
                wallet.ownerAddress,
                publicKey,
                Uint8Array.from(witness.signature),
                request
            )
        ).toBe(true);
        expect(JSON.stringify(wallet)).not.toContain(row.privateKey.slice(2));
    });

    it("accepts the EVM account signature as private spending authorization", async () => {
        const key = vectors.vectors[0]!.privateKey as `0x${string}`;
        const wallet = await deriveWallet(key);
        const signature = signWalletAuthorization(key, request);
        expect(
            await verifyWalletAuthorization(
                wallet.ownerAddress,
                secp256k1.getPublicKey(hexToBytes(key.slice(2)), false),
                signature,
                request
            )
        ).toBe(true);
    });

    it("rejects zero, out-of-range, malformed and wrong-length account keys", async () => {
        for (const input of [
            new Uint8Array(32),
            new Uint8Array(31),
            new Uint8Array(33),
            new Uint8Array(64),
            new Uint8Array(32).fill(255),
            "not-a-private-key",
            "11".repeat(32),
            ` 0x${"11".repeat(32)}`,
            "0xgg",
            "0x1",
            `0x${secp256k1.CURVE.n.toString(16)}`,
        ]) {
            await expect(LocalWallet.fromPrivateKey(input)).rejects.toThrow();
        }
    });
});
