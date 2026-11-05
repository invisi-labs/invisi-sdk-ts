import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptCreditNote, encryptCreditNote } from "../delivery/encryption";
import previous from "../delivery/testdata/previous-credit-envelope.json";
import type { CreditDeliveryState, CreditNote } from "../types";
import vectors from "../wallet/testdata/wallet-note-vectors.json";

const hexBytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text.slice(2), "hex"));
const word = (value: bigint, length = 32) =>
    Buffer.from(value.toString(16).padStart(length * 2, "0"), "hex");
const identity = (text: string): `0x${string}` => `0x${word(BigInt(text), 20).toString("hex")}`;
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
    tokenAddress: BigInt(vectors.context.tokenAddress),
};
const note: CreditNote = {
    payload: new Uint8Array(),
    ...context,
    ownerWalletIdentity: identity(vectors.credit.ownerWalletIdentity),
    spenderWalletIdentity: identity(vectors.credit.spenderWalletIdentity),
    ownerPayout: BigInt(vectors.credit.ownerPayout),
    spenderPayout: BigInt(vectors.credit.spenderPayout),
    amount: 100n,
    nonce: 678n,
    expiry: 2000000123n,
    creditSharedKey: 999n,
    singleLimit: BigInt(vectors.credit.singleLimit),
    dailyLimit: BigInt(vectors.credit.dailyLimit),
    monthlyLimit: BigInt(vectors.credit.monthlyLimit),
    lastDay: BigInt(vectors.credit.lastDay),
    dailySpent: BigInt(vectors.credit.dailySpent),
    lastMonth: BigInt(vectors.credit.lastMonth),
    monthlySpent: BigInt(vectors.credit.monthlySpent),
};
const clueKey = hexBytes("0xc69480518ea88f8cb925fbcd8f5100b1ebc46cc4d8cbe19e0478936567e6b211");
const state: CreditDeliveryState = {
    note,
    ownerReceivingKeys: { viewingPublicKey: hexBytes(vectors.owner.viewingPublicKey), clueKey },
    spenderReceivingKeys: {
        viewingPublicKey: hexBytes(vectors.spender.viewingPublicKey),
        clueKey: Uint8Array.from(clueKey),
    },
};
const leaf = vectors.credit.commitment as `0x${string}`;

describe("self-contained Credit delivery state", () => {
    it("recovers both public key snapshots and the complete Credit for either role", async () => {
        for (const role of ["owner", "spender"] as const) {
            const wallet = vectors[role],
                c = {
                    ...context,
                    outputCommitment: leaf,
                    ownerAddress: identity(wallet.ownerAddress),
                    role,
                };
            const envelope = await encryptCreditNote(hexBytes(wallet.viewingPublicKey), state, c);
            expect(envelope).toHaveLength(498);
            expect(envelope[0]).toBe(129);
            expect(
                await decryptCreditNote(hexBytes(wallet.viewingPrivateKey), envelope, c)
            ).toEqual(state);

            // This reference decrypts using Node, independently of production WebCrypto.
            const ecdh = createECDH("secp256k1");
            ecdh.setPrivateKey(hexBytes(wallet.viewingPrivateKey));
            const domain = Buffer.from("Invisi.CreditDelivery.v1"),
                data = Buffer.from(envelope);
            const key = hkdfSync(
                "sha256",
                ecdh.computeSecret(data.subarray(1, 34)),
                data.subarray(34, 50),
                Buffer.concat([
                    domain,
                    data.subarray(1, 34),
                    Buffer.from(hexBytes(wallet.viewingPublicKey)),
                ]),
                32
            );
            const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key), data.subarray(50, 62));
            cipher.setAAD(
                Buffer.concat([
                    domain,
                    data.subarray(0, 62),
                    Buffer.from([role === "owner" ? 1 : 2]),
                    word(context.chainId, 8),
                    word(context.protocolAddress, 20),
                    word(context.tokenAddress, 20),
                    word(BigInt(leaf)),
                ])
            );
            cipher.setAuthTag(data.subarray(482));
            const plain = Buffer.concat([cipher.update(data.subarray(62, 482)), cipher.final()]);
            expect(plain).toHaveLength(420);
            expect(plain.subarray(192, 322)).toEqual(
                Buffer.concat([
                    state.ownerReceivingKeys.viewingPublicKey,
                    clueKey,
                    state.spenderReceivingKeys.viewingPublicKey,
                    clueKey,
                ])
            );
        }
    });

    it("rejects missing or invalid receiving keys and a different actual recipient", async () => {
        const c = { ...context, outputCommitment: leaf, role: "owner" as const };
        await expect(
            encryptCreditNote(hexBytes(vectors.spender.viewingPublicKey), state, c)
        ).rejects.toThrow();
        await expect(
            encryptCreditNote(
                state.ownerReceivingKeys.viewingPublicKey,
                {
                    ...state,
                    spenderReceivingKeys: {
                        ...state.spenderReceivingKeys,
                        clueKey: new Uint8Array(32),
                    },
                },
                c
            )
        ).rejects.toThrow();
        await expect(
            encryptCreditNote(
                state.ownerReceivingKeys.viewingPublicKey,
                { ...state, ownerReceivingKeys: undefined } as unknown as CreditDeliveryState,
                c
            )
        ).rejects.toThrow();
    });

    it("rejects previous Credit formats instead of returning a note without recovery snapshots", async () => {
        const c = {
            ...context,
            outputCommitment: leaf,
            ownerAddress: note.ownerWalletIdentity,
            role: "owner" as const,
        };
        await expect(
            decryptCreditNote(
                hexBytes(vectors.owner.viewingPrivateKey),
                previous.envelope as `0x${string}`,
                c
            )
        ).rejects.toThrow();
    });
});

it("roundtrips full u128 actual usage even when owner limits are disabled or below used counters", async () => {
    const { computeCreditCommitment, computeCreditSharedKeyHash } =
        await import("./creditCommitment");
    const wide = {
        ...note,
        singleLimit: 0n,
        dailyLimit: 1n,
        monthlyLimit: 0n,
        dailySpent: (1n << 127n) + 1n,
        monthlySpent: (1n << 128n) - 1n,
    };
    const commitment = await computeCreditCommitment(
        wide.chainId,
        wide.spenderWalletIdentity,
        wide.ownerWalletIdentity,
        wide.spenderPayout,
        wide.ownerPayout,
        wide.tokenAddress,
        wide.amount,
        wide.nonce,
        wide.expiry,
        await computeCreditSharedKeyHash(wide.creditSharedKey),
        wide
    );
    const c = {
        ...context,
        outputCommitment: commitment,
        ownerAddress: wide.ownerWalletIdentity,
        role: "owner" as const,
    };
    const wideState = { ...state, note: wide };
    const encrypted = await encryptCreditNote(
        hexBytes(vectors.owner.viewingPublicKey),
        wideState,
        c
    );
    expect(encrypted).toHaveLength(498);
    expect(
        await decryptCreditNote(hexBytes(vectors.owner.viewingPrivateKey), encrypted, c)
    ).toEqual(wideState);
});
