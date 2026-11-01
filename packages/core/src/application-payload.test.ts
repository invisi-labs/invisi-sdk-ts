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
it("leaves application-defined address semantics outside the SDK and built-in memo codec", async () => {
    const applicationData = {
        refundTo: "application-defined-destination",
        message: "custom content",
    };
    const payload = new TextEncoder().encode(JSON.stringify(applicationData));
    const envelope = await core.encryptPrivateTransferNote(
        core.viewingPublicKey(key),
        { ...note, payload },
        context
    );
    const decoded = await core.decryptPrivateTransferNote(key, envelope, context);
    expect(JSON.parse(new TextDecoder().decode(decoded.payload))).toEqual(applicationData);
    expect(() => core.fundsV1.decode(decoded.payload)).toThrow(/version/);
    const viewer = new core.ViewingCapability(context.walletIdentity, key);
    const output = { ...context, role: "funds" as const, ciphertext: envelope };
    const disclosure = await viewer.discloseNote(envelope, output);
    expect(disclosure.getScope().revealsPayload).toBe(true);
    expect(disclosure.getScope()).not.toHaveProperty("revealsReturnAddress");
    expect(disclosure.getScope().revealsReceivingKeys).toBe(false);
    expect((await disclosure.verify(output)).note.payload).toEqual(payload);
    const opening = await core.Disclosure.fromNote(decoded);
    expect(opening.getScope().revealsPayload).toBe(false);
    expect((await opening.verify(output)).note).not.toHaveProperty("payload");
    const tampered = envelope.slice();
    tampered[150] = tampered[150]! ^ 1;
    await expect(core.decryptPrivateTransferNote(key, tampered, context)).rejects.toThrow();
});
