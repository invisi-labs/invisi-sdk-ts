import { describe, it, expect } from "vitest";
import { hexToBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import {
    deriveWallet,
    computeOwnerAddress,
    walletAuthorizationTypedData,
    computeWalletAuthorizationDigest,
    signWalletAuthorization,
    verifyWalletAuthorization,
} from "./wallet";
import { FIELD_MODULUS } from "./random";
import authorizationVectors from "./testdata/wallet-authorization-vectors.json";

const privateKey = new Uint8Array(32).fill(1);
const request = {
    context: { chainId: 31337n, protocolAddress: 0x1234n },
    operation: "transact" as const,
    capacity: 14,
    words: [31337n, 0x1234n],
};
it("rejects malformed owner public keys", async () => {
    await expect(computeOwnerAddress(new Uint8Array(33))).rejects.toThrow();
});

describe("private wallet authorization", () => {
    it("matches independent ABI/EIP712 encoders for every operation and capacity", () => {
        for (const row of authorizationVectors.rows) {
            const input = {
                context: {
                    chainId: BigInt(row.context.chainId),
                    protocolAddress: BigInt(row.context.protocolAddress),
                },
                operation: row.operation as typeof request.operation,
                capacity: row.capacity,
                words: row.words.map(BigInt),
            };
            expect(computeWalletAuthorizationDigest(input)).toBe(row.digest);
            expect(walletAuthorizationTypedData(input).message).toEqual(row.message);
        }
    });
    it("signs the complete typed statement and rejects changed roles, context and fields", async () => {
        const wallet = await deriveWallet(privateKey);
        const signature = signWalletAuthorization(wallet.spendingPrivateKey, request);
        expect(signature).toHaveLength(130);
        expect(
            await verifyWalletAuthorization(
                wallet.ownerAddress,
                wallet.spendingPublicKey,
                signature,
                request
            )
        ).toBe(true);
        expect(
            await verifyWalletAuthorization(
                "0x0000000000000000000000000000000000000001",
                wallet.spendingPublicKey,
                signature,
                request
            )
        ).toBe(false);
        for (const patch of [
            { capacity: 56 },
            { words: [...request.words, 1n] },
            { operation: "credit-draw" as const, capacity: 1 },
        ]) {
            expect(
                await verifyWalletAuthorization(
                    wallet.ownerAddress,
                    wallet.spendingPublicKey,
                    signature,
                    { ...request, ...patch }
                )
            ).toBe(false);
        }
        for (const changed of [
            { ...request, context: { ...request.context, chainId: 1n }, words: [1n, 0x1234n] },
            {
                ...request,
                context: { ...request.context, protocolAddress: 0x1235n },
                words: [31337n, 0x1235n],
            },
        ])
            expect(
                await verifyWalletAuthorization(
                    wallet.ownerAddress,
                    wallet.spendingPublicKey,
                    signature,
                    changed
                )
            ).toBe(false);
        for (const key of [wallet.viewingPrivateKey, wallet.detectionSeed]) {
            const pub = secp256k1.getPublicKey(key, false),
                sig = signWalletAuthorization(key, request);
            expect(await verifyWalletAuthorization(wallet.ownerAddress, pub, sig, request)).toBe(
                false
            );
        }
        expect(() => walletAuthorizationTypedData({ ...request, words: [1n, 0x1234n] })).toThrow(
            /chain/
        );
        expect(() =>
            walletAuthorizationTypedData({ ...request, words: [31337n, 0x1235n] })
        ).toThrow(/instance/);
        expect(() =>
            walletAuthorizationTypedData({ ...request, operation: "__proto__" as never })
        ).toThrow(/operation/);
        expect(() => walletAuthorizationTypedData({ ...request, capacity: 15 })).toThrow(
            /capacity/
        );
    });

    it("accepts valid raw ECDSA overflow recovery branches and rejects malformed signatures", async () => {
        const digest = hexToBytes(computeWalletAuthorizationDigest(request).slice(2));
        const signature = ("0x" + "02".padStart(64, "0") + "01".padStart(64, "0")) as `0x${string}`;
        const publicKey = secp256k1.Signature.fromCompact(signature.slice(2))
            .addRecoveryBit(2)
            .recoverPublicKey(digest)
            .toRawBytes(false);
        const identity = await computeOwnerAddress(publicKey);
        expect(await verifyWalletAuthorization(identity, publicKey, signature, request)).toBe(true);
        await expect(
            verifyWalletAuthorization(
                identity,
                publicKey,
                (signature + "00") as `0x${string}`,
                request
            )
        ).rejects.toThrow(/64|signature/);
        expect(
            await verifyWalletAuthorization(
                identity,
                publicKey,
                ("0x" + "00".repeat(64)) as `0x${string}`,
                request
            )
        ).toBe(false);
    });
});
