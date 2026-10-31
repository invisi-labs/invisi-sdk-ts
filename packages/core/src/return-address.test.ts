import { expect, it } from "vitest";
import * as core from "./index";
import { encodeLongAddress } from "./address";
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
const receivingAddress = encodeLongAddress({
    walletIdentity: `0x${BigInt(vectors.credit.spenderWalletIdentity).toString(16).padStart(40, "0")}`,
    viewingPublicKey: Uint8Array.from(
        Buffer.from(vectors.spender.viewingPublicKey.slice(2), "hex")
    ),
    clueKey: Uint8Array.from(
        Buffer.from(vectors.credit.spenderReceivingKeys.clueKey.slice(2), "hex")
    ),
});

it("roundtrips optional complete return addresses with independent opaque memos", async () => {
    for (const memo of [undefined, new Uint8Array(256).fill(255)]) {
        const envelope = await core.encryptPrivateTransferNote(
            core.viewingPublicKey(key),
            {
                ...note,
                returnAddress: receivingAddress,
                ...(memo ? { memo } : {}),
            },
            context
        );
        expect(envelope[0]).toBe(1);
        expect(envelope).toHaveLength(246 + (memo?.length ?? 0));
        const decoded = await core.decryptPrivateTransferNote(key, envelope, context);
        expect(decoded.returnAddress).toBe(receivingAddress);
        expect(decoded.memo).toEqual(memo);
        const viewer = new core.ViewingCapability(context.walletIdentity, key);
        const output = { ...context, role: "funds" as const, ciphertext: envelope };
        const disclosure = await viewer.discloseNote(envelope, output);
        expect(disclosure.getScope().revealsReturnAddress).toBe(true);
        expect(disclosure.getScope().revealsReceivingKeys).toBe(true);
        expect((await disclosure.verify(output)).note).toHaveProperty(
            "returnAddress",
            receivingAddress
        );
        const opening = await core.Disclosure.fromNote(decoded);
        expect(opening.getScope().revealsReturnAddress).toBe(false);
        expect((await opening.verify(output)).note).not.toHaveProperty("returnAddress");
        const tampered = envelope.slice();
        tampered[150] = tampered[150]! ^ 1;
        await expect(core.decryptPrivateTransferNote(key, tampered, context)).rejects.toThrow();
    }
});

it("omits return metadata by default without a legacy encoding fallback", async () => {
    const envelope = await core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        note,
        context
    );
    expect(envelope[0]).toBe(1);
    expect(envelope).toHaveLength(161);
    expect(await core.decryptPrivateTransferNote(key, envelope, context)).not.toHaveProperty(
        "returnAddress"
    );
    const oldVersion = envelope.slice();
    oldVersion[0] = 2;
    await expect(core.decryptPrivateTransferNote(key, oldVersion, context)).rejects.toThrow(
        /version/
    );
});

it("rejects short, unchecked or invalid return addresses without registry resolution", async () => {
    for (const returnAddress of [
        context.walletIdentity,
        "0iinvalid",
        receivingAddress.toLowerCase(),
        "",
    ]) {
        await expect(
            core.encryptPrivateTransferNote(
                core.viewingPublicKey(key),
                {
                    ...note,
                    returnAddress,
                },
                context
            )
        ).rejects.toThrow(/address|checksum/i);
    }
});
