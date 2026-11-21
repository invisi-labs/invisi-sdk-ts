import { expect, it } from "vitest";
import * as core from "../index";
import vectors from "../wallet/testdata/wallet-note-vectors.json";
const key = Uint8Array.from(Buffer.from(vectors.owner.viewingPrivateKey.slice(2), "hex"));
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
    tokenAddress: BigInt(vectors.context.tokenAddress),
    ownerAddress:
        `0x${BigInt(vectors.note.ownerAddress).toString(16).padStart(40, "0")}` as `0x${string}`,
    outputCommitment: vectors.note.commitment as `0x${string}`,
};
const note = { ...context, amount: BigInt(vectors.note.amount), nonce: BigInt(vectors.note.nonce) };
it("roundtrips copied opaque memo bytes including NUL and invalid UTF-8", async () => {
    const memo = new Uint8Array([0, 255, 192, 128]);
    const pending = core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, payload: core.fundsV1.encode({ memo }) },
        context
    );
    memo.fill(9);
    const envelope = await pending;
    expect(envelope[0]).toBe(1);
    expect(envelope).toHaveLength(165);
    const decoded = await core.decryptPrivateTransferNote(key, envelope, context);
    expect(core.fundsV1.decode(decoded.payload!).memo).toEqual(new Uint8Array([0, 255, 192, 128]));
    expect(() =>
        core.decodeMemoText(core.fundsV1.decode(decoded.payload!).memo as Uint8Array)
    ).toThrow();
});
it("encodes text as UTF-8 and caps encoded text and raw memos at 256 bytes", async () => {
    for (const memo of ["a".repeat(256), "é".repeat(128), new Uint8Array(256)]) {
        const envelope = await core.encryptPrivateTransferNote(
            core.viewingPublicKey(key),
            { ...note, payload: core.fundsV1.encode({ memo }) },
            context
        );
        expect(envelope).toHaveLength(417);
        const decoded = await core.decryptPrivateTransferNote(key, envelope, context);
        expect(core.fundsV1.decode(decoded.payload!).memo).toBeInstanceOf(Uint8Array);
    }
    for (const memo of ["a".repeat(257), "é".repeat(129), new Uint8Array(257), "\ud800"]) {
        expect(() => core.fundsV1.encode({ memo })).toThrow(/memo|surrogate/i);
    }
});
it("preserves empty note object semantics and excludes memos from commitment openings", async () => {
    const envelope = await core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, payload: core.fundsV1.encode({ memo: "" }) },
        context
    );
    expect(envelope).toHaveLength(161);
    expect(
        core.fundsV1.decode((await core.decryptPrivateTransferNote(key, envelope, context)).payload)
            .memo
    ).toBeUndefined();
    const opening = await core.Disclosure.fromNote({
        ...note,
        payload: core.fundsV1.encode({ memo: "private" }),
    });
    expect(opening.export().data).not.toHaveProperty("memo");
});

it("reveals raw funds memos only through the selected payload-key disclosure", async () => {
    const memo = new Uint8Array([255, 0, 65]);
    const envelope = await core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, payload: core.fundsV1.encode({ memo }) },
        context
    );
    const viewer = new core.ViewingCapability(context.ownerAddress, key);
    const output = { ...context, role: "funds" as const, ciphertext: envelope };
    const keyed = await viewer.discloseNote(envelope, output);
    expect(keyed.getScope().revealsMemo).toBe(true);
    expect(core.fundsV1.decode((await keyed.verify(output)).note.payload!).memo).toEqual(memo);
    const opening = await core.Disclosure.fromNote({
        ...note,
        payload: core.fundsV1.encode({ memo }),
    });
    expect(opening.getScope().revealsMemo).toBe(false);
    expect((await opening.verify(output)).note).not.toHaveProperty("payload");
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
            grantId: BigInt(vectors.credit.grantId),
            nonce: BigInt(vectors.credit.nonce),
            expiry: BigInt(vectors.credit.expiry),
            creditSharedKey: BigInt(vectors.credit.creditSharedKey),
            singleLimit: BigInt(vectors.credit.singleLimit),
            dailyLimit: BigInt(vectors.credit.dailyLimit),
            monthlyLimit: BigInt(vectors.credit.monthlyLimit),
            availableCredit: BigInt(vectors.credit.availableCredit),
            unlimited: vectors.credit.unlimited,
            lastDay: BigInt(vectors.credit.lastDay),
            dailySpent: BigInt(vectors.credit.dailySpent),
            lastMonth: BigInt(vectors.credit.lastMonth),
            monthlySpent: BigInt(vectors.credit.monthlySpent),
            totalSpent: BigInt(vectors.credit.totalSpent),
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
            ownerAddress: address(
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
        const pending = core.encryptCreditState(
            publicKey,
            { ...state, note: { ...state.note, payload: core.creditV1.encode({ memo }) } },
            scoped
        );
        memo.fill(0);
        const envelope = await pending;
        expect(envelope[0]).toBe(132);
        expect(envelope).toHaveLength(748);
        const decoded = await core.decryptCreditState(privateKey, envelope, scoped);
        expect(core.creditV1.decode(decoded.note.payload!).memo).toEqual(
            new Uint8Array(256).fill(255)
        );
        const viewer = new core.ViewingCapability(scoped.ownerAddress, privateKey);
        const keyed = await viewer.discloseCredit(envelope, scoped);
        expect(
            core.creditV1.decode(
                (await keyed.verify({ ...scoped, ciphertext: envelope })).note.payload!
            ).memo
        ).toEqual(new Uint8Array(256).fill(255));
        const opening = await core.Disclosure.fromCredit({
            ...state.note,
            payload: core.creditV1.encode({ memo: "hidden" }),
        });
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
                payload: core.fundsV1.encode({ memo }),
            });
        } else {
            const decoded = await core.decryptCreditState(
                privateKey,
                vector.ciphertext as `0x${string}`,
                {
                    ...context,
                    ownerAddress: identity(vectors[role].ownerAddress),
                    role,
                    outputCommitment: vectors.credit.commitment as `0x${string}`,
                }
            );
            expect(decoded.note).toMatchObject({
                nonce: BigInt(vectors.credit.nonce),
                creditSharedKey: BigInt(vectors.credit.creditSharedKey),
                singleLimit: BigInt(vectors.credit.singleLimit),
                dailyLimit: BigInt(vectors.credit.dailyLimit),
                monthlyLimit: BigInt(vectors.credit.monthlyLimit),
                availableCredit: BigInt(vectors.credit.availableCredit),
                unlimited: vectors.credit.unlimited,
                lastDay: BigInt(vectors.credit.lastDay),
                dailySpent: BigInt(vectors.credit.dailySpent),
                lastMonth: BigInt(vectors.credit.lastMonth),
                monthlySpent: BigInt(vectors.credit.monthlySpent),
                totalSpent: BigInt(vectors.credit.totalSpent),
                payload: core.creditV1.encode({ memo }),
            });
        }
    }
});
