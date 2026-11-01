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
it("restores fixed funds fields and arbitrary unknown application payloads without codecs", async () => {
    for (const payload of [
        undefined,
        new Uint8Array(),
        new Uint8Array([255, 255, 0, 128]),
        new Uint8Array(3936).fill(99),
    ]) {
        const envelope = await core.encryptPrivateTransferNote(
            core.viewingPublicKey(key),
            { ...note, ...(payload === undefined ? {} : { payload }) },
            context
        );
        expect(envelope[0]).toBe(1);
        const decoded = await core.decryptPrivateTransferNote(key, envelope, context);
        expect(decoded.amount).toBe(note.amount);
        expect(decoded.payload).toEqual(payload ?? new Uint8Array());
        decoded.payload.fill(0);
        expect((await core.decryptPrivateTransferNote(key, envelope, context)).payload).toEqual(
            payload ?? new Uint8Array()
        );
    }
    await expect(
        core.encryptPrivateTransferNote(
            core.viewingPublicKey(key),
            { ...note, payload: new Uint8Array(3937) },
            context
        )
    ).rejects.toThrow(/length|size|limit/);
});
it("requires an explicit application decode and leaves unknown application versions intact", async () => {
    const payload = core.fundsV1.encode({ memo: "hello" });
    expect(payload).toBeInstanceOf(Uint8Array);
    const envelope = await core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, payload },
        context
    );
    const decoded = await core.decryptPrivateTransferNote(key, envelope, context);
    expect(core.fundsV1.decode(decoded.payload).memo).toEqual(core.encodeMemo("hello"));
    const unknown = payload.slice();
    unknown[0] = 99;
    const unknownEnvelope = await core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, payload: unknown },
        context
    );
    expect((await core.decryptPrivateTransferNote(key, unknownEnvelope, context)).payload).toEqual(
        unknown
    );
    expect(() => core.fundsV1.decode(unknown)).toThrow(/version/);
    const badEnvelope = envelope.slice();
    badEnvelope[0] = 2;
    await expect(core.decryptPrivateTransferNote(key, badEnvelope, context)).rejects.toThrow(
        /version/
    );
});
it("restores and discloses Credit raw payloads for both roles without application parsers", async () => {
    const ownerScope = {
        ...context,
        role: "owner" as const,
        outputCommitment: vectors.credit.commitment as `0x${string}`,
    };
    const state = await core.decryptCreditNote(
        key,
        vectors.credit.ownerCiphertext as `0x${string}`,
        ownerScope
    );
    for (const role of ["owner", "spender"] as const) {
        const secret = Uint8Array.from(
            Buffer.from(vectors[role].viewingPrivateKey.slice(2), "hex")
        );
        const publicKey = core.viewingPublicKey(secret);
        const scope = {
            ...ownerScope,
            role,
            walletIdentity:
                role === "owner"
                    ? state.note.ownerWalletIdentity
                    : state.note.spenderWalletIdentity,
        };
        const payload = new Uint8Array(3598).fill(255);
        const envelope = await core.encryptCreditNote(
            publicKey,
            { ...state, note: { ...state.note, payload } },
            scope
        );
        expect(envelope.length).toBe(4096);
        expect(envelope[0]).toBe(129);
        const decoded = await core.decryptCreditNote(secret, envelope, scope);
        expect(decoded.note.payload).toEqual(payload);
        const viewer = new core.ViewingCapability(scope.walletIdentity, secret);
        const output = { ...scope, ciphertext: envelope };
        const disclosure = await viewer.discloseCredit(envelope, scope);
        const imported = await core.Disclosure.fromExport(disclosure.export());
        expect((await imported.verify(output)).note.payload).toEqual(payload);
        await expect(
            core.encryptCreditNote(
                publicKey,
                { ...state, note: { ...state.note, payload: new Uint8Array(3599) } },
                scope
            )
        ).rejects.toThrow(/length/);
    }
});
