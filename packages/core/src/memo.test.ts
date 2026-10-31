import { expect, it } from "vitest";
import * as core from "./index";
import vectors from "./testdata/wallet-note-vectors.json";
const key = Uint8Array.from(Buffer.from(vectors.owner.viewingPrivateKey.slice(2), "hex"));
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
    tokenAddress: BigInt(vectors.context.tokenAddress),
    walletIdentity:
        `0x${BigInt(vectors.note.walletIdentity).toString(16).padStart(40, "0")}` as `0x${string}`,
    outputCommitment: vectors.note.commitment as `0x${string}`,
};
const note = { ...context, amount: BigInt(vectors.note.amount), nonce: BigInt(vectors.note.nonce) };
it("roundtrips copied opaque memo bytes including NUL and invalid UTF-8", async () => {
    const memo = new Uint8Array([0, 255, 192, 128]);
    const pending = core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, memo },
        context
    );
    memo.fill(9);
    const envelope = await pending;
    expect(envelope[0]).toBe(1);
    expect(envelope).toHaveLength(165);
    const decoded = await core.decryptPrivateTransferNote(key, envelope, context);
    expect(decoded.memo).toEqual(new Uint8Array([0, 255, 192, 128]));
    expect(() => core.decodeMemoText(decoded.memo as Uint8Array)).toThrow();
});
it("encodes text as UTF-8 and caps encoded text and raw memos at 256 bytes", async () => {
    for (const memo of ["a".repeat(256), "é".repeat(128), new Uint8Array(256)]) {
        const envelope = await core.encryptPrivateTransferNote(
            core.viewingPublicKey(key),
            { ...note, memo },
            context
        );
        expect(envelope).toHaveLength(417);
        const decoded = await core.decryptPrivateTransferNote(key, envelope, context);
        expect(decoded.memo).toBeInstanceOf(Uint8Array);
    }
    for (const memo of ["a".repeat(257), "é".repeat(129), new Uint8Array(257), "\ud800"]) {
        await expect(
            core.encryptPrivateTransferNote(core.viewingPublicKey(key), { ...note, memo }, context)
        ).rejects.toThrow(/memo|surrogate/i);
    }
});
it("preserves empty note object semantics and excludes memos from commitment openings", async () => {
    const envelope = await core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, memo: "" },
        context
    );
    expect(envelope).toHaveLength(161);
    expect(await core.decryptPrivateTransferNote(key, envelope, context)).not.toHaveProperty(
        "memo"
    );
    const opening = await core.Disclosure.fromNote({ ...note, memo: "private" });
    expect(opening.export().data).not.toHaveProperty("memo");
});

it("reveals raw funds memos only through the selected payload-key disclosure", async () => {
    const memo = new Uint8Array([255, 0, 65]);
    const envelope = await core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, memo },
        context
    );
    const viewer = new core.ViewingCapability(context.walletIdentity, key);
    const output = { ...context, role: "funds" as const, ciphertext: envelope };
    const keyed = await viewer.discloseNote(envelope, output);
    expect(keyed.getScope().revealsMemo).toBe(true);
    expect((await keyed.verify(output)).note.memo).toEqual(memo);
    const opening = await core.Disclosure.fromNote({ ...note, memo });
    expect(opening.getScope().revealsMemo).toBe(false);
    expect((await opening.verify(output)).note).not.toHaveProperty("memo");
});
it("roundtrips copied Credit memos for both recipient roles and scoped disclosure", async () => {
    const address = (value: string) =>
        `0x${BigInt(value).toString(16).padStart(40, "0")}` as `0x${string}`;
    const state: core.CreditDeliveryState = {
        note: {
            chainId: context.chainId,
            protocolAddress: context.protocolAddress,
            tokenAddress: context.tokenAddress,
            spenderWalletIdentity: address(vectors.credit.spenderWalletIdentity),
            ownerWalletIdentity: address(vectors.credit.ownerWalletIdentity),
            spenderPayout: BigInt(vectors.credit.spenderPayout),
            ownerPayout: BigInt(vectors.credit.ownerPayout),
            amount: BigInt(vectors.credit.amount),
            nonce: BigInt(vectors.credit.nonce),
            expiry: BigInt(vectors.credit.expiry),
            creditSharedKey: BigInt(vectors.credit.creditSharedKey),
            singleLimit: BigInt(vectors.credit.singleLimit),
            dailyLimit: BigInt(vectors.credit.dailyLimit),
            monthlyLimit: BigInt(vectors.credit.monthlyLimit),
            lastDay: BigInt(vectors.credit.lastDay),
            dailySpent: BigInt(vectors.credit.dailySpent),
            lastMonth: BigInt(vectors.credit.lastMonth),
            monthlySpent: BigInt(vectors.credit.monthlySpent),
        },
        ownerReceivingKeys: {
            viewingPublicKey: core.viewingPublicKey(key),
            clueKey: Uint8Array.from(
                Buffer.from(vectors.credit.ownerReceivingKeys.clueKey.slice(2), "hex")
            ),
        },
        spenderReceivingKeys: {
            viewingPublicKey: Uint8Array.from(
                Buffer.from(vectors.spender.viewingPublicKey.slice(2), "hex")
            ),
            clueKey: Uint8Array.from(
                Buffer.from(vectors.credit.spenderReceivingKeys.clueKey.slice(2), "hex")
            ),
        },
    };
    for (const role of ["owner", "spender"] as const) {
        const memo = new Uint8Array(256).fill(255);
        const scoped = {
            ...context,
            outputCommitment: vectors.credit.commitment as `0x${string}`,
            walletIdentity: address(
                vectors.credit[
                    (role + "WalletIdentity") as "ownerWalletIdentity" | "spenderWalletIdentity"
                ]
            ),
            role,
        };
        const publicKey =
            state[role === "owner" ? "ownerReceivingKeys" : "spenderReceivingKeys"]
                .viewingPublicKey;
        const privateKey = Uint8Array.from(
            Buffer.from(vectors[role].viewingPrivateKey.slice(2), "hex")
        );
        const pending = core.encryptCreditNote(
            publicKey,
            { ...state, note: { ...state.note, memo } },
            scoped
        );
        memo.fill(0);
        const envelope = await pending;
        expect(envelope[0]).toBe(129);
        expect(envelope).toHaveLength(754);
        const decoded = await core.decryptCreditNote(privateKey, envelope, scoped);
        expect(decoded.note.memo).toEqual(new Uint8Array(256).fill(255));
        const viewer = new core.ViewingCapability(scoped.walletIdentity, privateKey);
        const keyed = await viewer.discloseCredit(envelope, scoped);
        expect((await keyed.verify({ ...scoped, ciphertext: envelope })).note.memo).toEqual(
            new Uint8Array(256).fill(255)
        );
        const opening = await core.Disclosure.fromCredit({ ...state.note, memo: "hidden" });
        expect(opening.export().data).not.toHaveProperty("memo");
    }
});

it("decrypts every independently generated text and opaque shared memo vector", async () => {
    const identity = (value: string) =>
        `0x${BigInt(value).toString(16).padStart(40, "0")}` as `0x${string}`;
    for (const vector of vectors.memoVectors) {
        const memo = Uint8Array.from(Buffer.from(vector.memo.slice(2), "hex"));
        const role = vector.role as "owner" | "spender";
        const privateKey = Uint8Array.from(
            Buffer.from(vectors[role].viewingPrivateKey.slice(2), "hex")
        );
        if (vector.kind === "funds") {
            const decoded = await core.decryptPrivateTransferNote(
                privateKey,
                vector.ciphertext as `0x${string}`,
                context
            );
            expect(decoded).toMatchObject({
                amount: BigInt(vectors.note.amount),
                nonce: BigInt(vectors.note.nonce),
                memo,
            });
        } else {
            const decoded = await core.decryptCreditNote(
                privateKey,
                vector.ciphertext as `0x${string}`,
                {
                    ...context,
                    walletIdentity: identity(vectors[role].walletIdentity),
                    role,
                    outputCommitment: vectors.credit.commitment as `0x${string}`,
                }
            );
            expect(decoded.note).toMatchObject({
                amount: BigInt(vectors.credit.amount),
                nonce: BigInt(vectors.credit.nonce),
                creditSharedKey: BigInt(vectors.credit.creditSharedKey),
                singleLimit: BigInt(vectors.credit.singleLimit),
                dailyLimit: BigInt(vectors.credit.dailyLimit),
                monthlyLimit: BigInt(vectors.credit.monthlyLimit),
                lastDay: BigInt(vectors.credit.lastDay),
                dailySpent: BigInt(vectors.credit.dailySpent),
                lastMonth: BigInt(vectors.credit.lastMonth),
                monthlySpent: BigInt(vectors.credit.monthlySpent),
                memo,
            });
        }
    }
});
