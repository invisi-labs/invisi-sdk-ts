import { it, expect, vi } from "vitest";
import { getBytes, toBeHex } from "ethers";
import { authenticatedDecryptor, type DeliveryDecryptor } from "./decryptor";
import { deliveryCodec } from "./delivery-codec";
import { decryptPrivateTransferNote, decryptCreditState } from "./encryption";
import { Wallet } from "../wallet/wallet-object";
import vectors from "../wallet/testdata/wallet-note-vectors.json";

const ownerAddress = toBeHex(BigInt(vectors.owner.ownerAddress), 20) as `0x${string}`;
const wallet = Wallet.fromAddress(ownerAddress);
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
    tokenAddress: BigInt(vectors.context.tokenAddress),
    outputCommitment: vectors.note.commitment as `0x${string}`,
};
const noteEnvelope = vectors.note.ciphertext as `0x${string}`;
const creditEnvelope = vectors.credit.ownerCiphertext as `0x${string}`;
const key = vectors.owner.viewingPrivateKey as `0x${string}`;
const app: DeliveryDecryptor = {
    async decryptNote(envelope, request) {
        const codec = deliveryCodec(getBytes(envelope)[0]!);
        if (codec.kind !== "funds") throw Error("wrong kind");
        return codec.encode(await decryptPrivateTransferNote(key, envelope, request));
    },
    async decryptCredit(envelope, request) {
        const codec = deliveryCodec(getBytes(envelope)[0]!);
        if (codec.kind !== "credit") throw Error("wrong kind");
        return codec.encode(await decryptCreditState(key, envelope, request));
    },
};

it("authenticates App Note and Credit plaintext against public vectors", async () => {
    const viewing = authenticatedDecryptor(wallet, app);
    expect((await viewing.decryptNote(noteEnvelope, context))?.amount).toBe(70n);
    const credit = await viewing.decryptCredit(creditEnvelope, {
        ...context,
        outputCommitment: vectors.credit.commitment as `0x${string}`,
        role: "owner",
    });
    expect(credit?.note.ownerWalletIdentity).toBe(ownerAddress);
});

it("skips only explicit nonrecipients and propagates App errors", async () => {
    const nonrecipient = authenticatedDecryptor(wallet, {
        decryptNote: async () => null,
        decryptCredit: async () => null,
    });
    expect(await nonrecipient.decryptNote(noteEnvelope, context)).toBeNull();
    const failed = authenticatedDecryptor(wallet, {
        ...app,
        decryptNote: async () => {
            throw Error("App wallet locked");
        },
    });
    await expect(failed.decryptNote(noteEnvelope, context)).rejects.toThrow("App wallet locked");
});

it("rejects plaintext substituted from another commitment, owner or token", async () => {
    const plaintext = await app.decryptNote(noteEnvelope, { ...context, ownerAddress });
    const viewing = authenticatedDecryptor(wallet, { ...app, decryptNote: async () => plaintext });
    await expect(
        viewing.decryptNote(noteEnvelope, {
            ...context,
            outputCommitment: toBeHex(1, 32) as `0x${string}`,
        })
    ).rejects.toThrow(/commitment/);
    await expect(
        viewing.decryptNote(noteEnvelope, { ...context, tokenAddress: 1n })
    ).rejects.toThrow(/context|commitment/);
    const other = authenticatedDecryptor(Wallet.fromAddress(toBeHex(1, 20)), {
        ...app,
        decryptNote: async () => plaintext,
    });
    await expect(other.decryptNote(noteEnvelope, context)).rejects.toThrow(/context|commitment/);
});

it("rejects wrong envelope kinds before invoking the App", async () => {
    const decryptNote = vi.fn(app.decryptNote);
    await expect(
        authenticatedDecryptor(wallet, { ...app, decryptNote }).decryptNote(creditEnvelope, context)
    ).rejects.toThrow(/kind/);
    expect(decryptNote).not.toHaveBeenCalled();
});

it("rejects a Credit plaintext delivered under the other role", async () => {
    const creditContext = {
        ...context,
        ownerAddress,
        outputCommitment: vectors.credit.commitment as `0x${string}`,
        role: "owner" as const,
    };
    const plaintext = await app.decryptCredit(creditEnvelope, creditContext);
    const viewing = authenticatedDecryptor(wallet, {
        ...app,
        decryptCredit: async () => plaintext,
    });
    await expect(
        viewing.decryptCredit(creditEnvelope, { ...creditContext, role: "spender" })
    ).rejects.toThrow(/context|commitment|role/);
});
