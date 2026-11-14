import { describe, expect, it } from "vitest";
import { AbiCoder, keccak256, TypedDataEncoder } from "ethers";
import { decodeAddress, encodeLongAddress, encodeShortAddress } from "../address/address";
import { poseidonHash } from "../crypto/poseidon";
import { computeNoteNullifier } from "../notes/nullifier";
import {
    computeOwnerAddress,
    computeWalletAuthorizationDigest,
    deriveWallet,
    walletAuthorizationTypedData,
    type WalletOperation,
} from "./wallet";

const key = "0x" + "01".padStart(64, "0");

describe("EVM owner receipt and authorization", () => {
    it("preserves canonical authorization across the contract bulk-copy boundary", () => {
        const context = { chainId: 31337n, protocolAddress: 0x1234n };
        const operations: [WalletOperation, number][] = [
            ["transact", 190],
            ["create-credit", 1],
            ["update-credit", 1],
            ["credit-draw", 80],
        ];
        for (const [operation, capacity] of operations) {
            for (const length of [2, 127, 128, 129, 585, 815]) {
                const words = Array.from({ length }, (_, i) => BigInt(i + 100));
                words[0] = context.chainId;
                words[1] = context.protocolAddress;
                const request = { context, operation, capacity, words };
                const typed = walletAuthorizationTypedData(request);
                expect(typed.message.statementHash).toBe(
                    keccak256(
                        AbiCoder.defaultAbiCoder().encode(
                            ["uint256", "bytes32[]"],
                            [
                                capacity,
                                words.map((value) => `0x${value.toString(16).padStart(64, "0")}`),
                            ]
                        )
                    )
                );
                expect(computeWalletAuthorizationDigest(request)).toBe(
                    TypedDataEncoder.hash(
                        typed.domain,
                        { WalletAuthorization: [...typed.types.WalletAuthorization] },
                        typed.message
                    )
                );
                expect(
                    computeWalletAuthorizationDigest({ ...request, words: [...words, 0n] })
                ).not.toBe(computeWalletAuthorizationDigest(request));
            }
        }
    });

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
        expect(await computeNoteNullifier(31337n, 0x1234n, 0n, commitment)).toBe(
            await poseidonHash([4n, 31337n, 0x1234n, 0n, BigInt(commitment)])
        );
    });
});
