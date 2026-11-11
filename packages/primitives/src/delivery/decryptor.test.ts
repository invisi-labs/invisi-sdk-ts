import { it, expect, vi } from "vitest";
import { getBytes, toBeHex } from "ethers";
import { authenticatedDecryptor, type DeliveryDecryptor } from "./decryptor";
import { deliveryCodec } from "./delivery-codec";
import { decryptPrivateTransferNote, decryptCreditState } from "./encryption";
import vectors from "../wallet/testdata/wallet-note-vectors.json";

const ownerAddress = toBeHex(BigInt(vectors.owner.ownerAddress), 20) as `0x${string}`;
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
    const viewing = authenticatedDecryptor(ownerAddress, app);
    expect((await viewing.decryptNote(noteEnvelope, context))?.amount).toBe(70n);
    const credit = await viewing.decryptCredit(creditEnvelope, {
        ...context,
        outputCommitment: vectors.credit.commitment as `0x${string}`,
        role: "owner",
    });
    expect(credit?.note.ownerWalletIdentity).toBe(ownerAddress);
});

it("skips only explicit nonrecipients and propagates App errors", async () => {
    const nonrecipient = authenticatedDecryptor(ownerAddress, {
        decryptNote: async () => null,
        decryptCredit: async () => null,
    });
    expect(await nonrecipient.decryptNote(noteEnvelope, context)).toBeNull();
    const failed = authenticatedDecryptor(ownerAddress, {
        ...app,
        decryptNote: async () => {
            throw Error("App wallet locked");
        },
    });
    await expect(failed.decryptNote(noteEnvelope, context)).rejects.toThrow("App wallet locked");
});

it("rejects plaintext substituted from another commitment, owner or token", async () => {
    const plaintext = await app.decryptNote(noteEnvelope, { ...context, ownerAddress });
    const viewing = authenticatedDecryptor(ownerAddress, {
        ...app,
        decryptNote: async () => plaintext,
    });
    await expect(
        viewing.decryptNote(noteEnvelope, {
            ...context,
            outputCommitment: toBeHex(1, 32) as `0x${string}`,
        })
    ).rejects.toThrow(/commitment/);
    await expect(
        viewing.decryptNote(noteEnvelope, { ...context, tokenAddress: 1n })
    ).rejects.toThrow(/context|commitment/);
    const other = authenticatedDecryptor(toBeHex(1, 20) as `0x${string}`, {
        ...app,
        decryptNote: async () => plaintext,
    });
    await expect(other.decryptNote(noteEnvelope, context)).rejects.toThrow(/context|commitment/);
});

it("rejects wrong envelope kinds before invoking the App", async () => {
    const decryptNote = vi.fn(app.decryptNote);
    await expect(
        authenticatedDecryptor(ownerAddress, { ...app, decryptNote }).decryptNote(
            creditEnvelope,
            context
        )
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
    const viewing = authenticatedDecryptor(ownerAddress, {
        ...app,
        decryptCredit: async () => plaintext,
    });
    await expect(
        viewing.decryptCredit(creditEnvelope, { ...creditContext, role: "spender" })
    ).rejects.toThrow(/context|commitment|role/);
});

it("passes complete native detection context and rejects mismatched accounts or result lengths", async () => {
    const candidates = [
        {
            ...context,
            ownerAddress,
            role: "funds" as const,
            clue: "0x1234" as const,
            ciphertext: noteEnvelope,
        },
    ];
    const detect = vi.fn(async () => ({ ownerAddress, results: ["candidate" as const] }));
    const viewing = authenticatedDecryptor(ownerAddress, { ...app, detect });
    expect(await viewing.detectCandidates(candidates)).toEqual(["candidate"]);
    expect(detect.mock.calls).toHaveLength(1);
    expect(detect).toHaveBeenCalledWith(candidates);
    for (const result of [
        { ownerAddress: toBeHex(1, 20) as `0x${string}`, results: ["candidate" as const] },
        { ownerAddress, results: [] },
    ]) {
        await expect(
            authenticatedDecryptor(ownerAddress, {
                ...app,
                detect: async () => result,
            }).detectCandidates(candidates)
        ).rejects.toThrow(/wrong account|invalid detection/);
    }
});
it("distinguishes ambiguous AEAD authentication from host failures for both delivery roles", async () => {
    const { DeliveryAuthenticationError } = await import("./errors");
    const ambiguous = authenticatedDecryptor(ownerAddress, {
        async decryptNote() {
            return { status: "authentication-failed" };
        },
        async decryptCredit() {
            return { status: "authentication-failed" };
        },
    });
    await expect(ambiguous.decryptNote(noteEnvelope, context)).rejects.toBeInstanceOf(
        DeliveryAuthenticationError
    );
    await expect(
        ambiguous.decryptCredit(creditEnvelope, {
            ...context,
            outputCommitment: vectors.credit.commitment as `0x${string}`,
            role: "owner",
        })
    ).rejects.toBeInstanceOf(DeliveryAuthenticationError);
    const damaged = getBytes(noteEnvelope);
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    await expect(
        decryptPrivateTransferNote(key, damaged, { ...context, ownerAddress })
    ).rejects.toBeInstanceOf(DeliveryAuthenticationError);
    await expect(
        decryptPrivateTransferNote(`0x${"02".repeat(32)}`, noteEnvelope, {
            ...context,
            ownerAddress,
        })
    ).rejects.toBeInstanceOf(DeliveryAuthenticationError);
    for (const reason of ["locked", "cancelled", "session expired", "wrong account"]) {
        await expect(
            authenticatedDecryptor(ownerAddress, {
                ...app,
                async decryptCredit() {
                    throw Error(reason);
                },
            }).decryptCredit(creditEnvelope, { ...context, role: "owner" })
        ).rejects.toThrow(reason);
    }
});

it("authenticates the spender Credit role with the spender account and full native context", async () => {
    const spender = toBeHex(BigInt(vectors.spender.ownerAddress), 20) as `0x${string}`;
    const request = {
        ...context,
        outputCommitment: vectors.credit.commitment as `0x${string}`,
        role: "spender" as const,
        clue: "0x1234" as const,
    };
    const decryptCredit = vi.fn(
        async (
            envelope: import("./types").NoteBytes,
            full: import("./types").CreditStateDecryptionContext
        ) => {
            expect(full).toEqual({ ...request, ownerAddress: spender });
            const codec = deliveryCodec(getBytes(envelope)[0]!);
            if (codec.kind !== "credit") throw Error("wrong kind");
            return codec.encode(
                await decryptCreditState(
                    vectors.spender.viewingPrivateKey as `0x${string}`,
                    envelope,
                    full
                )
            );
        }
    );
    const active = authenticatedDecryptor(spender, { ...app, decryptCredit });
    expect(
        (await active.decryptCredit(vectors.credit.spenderCiphertext as `0x${string}`, request))
            ?.note.spenderWalletIdentity
    ).toBe(spender);
});
