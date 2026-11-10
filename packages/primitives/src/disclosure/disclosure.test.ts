import { createECDH, hkdfSync } from "node:crypto";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import * as core from "../index";
import vectors from "../wallet/testdata/wallet-note-vectors.json";

const hex = (value: string | number | bigint): `0x${string}` =>
    `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
    tokenAddress: BigInt(vectors.context.tokenAddress),
};
const note: core.Note = {
    ...context,
    ownerAddress: ownerHex(vectors.note.ownerAddress),
    amount: BigInt(vectors.note.amount),
    nonce: BigInt(vectors.note.nonce),
};
const credit: core.CreditState = {
    ...context,
    spenderWalletIdentity: ownerHex(vectors.credit.spenderWalletIdentity),
    ownerWalletIdentity: ownerHex(vectors.credit.ownerWalletIdentity),
    revocationShard: BigInt(vectors.credit.revocationShard),
    revocationSlot: BigInt(vectors.credit.revocationSlot),
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
};
const output = {
    ...context,
    outputCommitment: vectors.note.commitment as `0x${string}`,
    role: "funds" as const,
    ciphertext: vectors.note.ciphertext as `0x${string}`,
};
const creditOutput = {
    ...context,
    outputCommitment: vectors.credit.commitment as `0x${string}`,
    role: "owner" as const,
    ciphertext: vectors.credit.ownerCiphertext as `0x${string}`,
};
const viewer = new core.ViewingCapability(
    note.ownerAddress,
    vectors.owner.viewingPrivateKey as `0x${string}`
);

describe("selective disclosure", () => {
    it("verifies and round-trips a note opening against an independent protocol commitment", async () => {
        const disclosure = await core.Disclosure.fromNote(note);
        const imported = await core.Disclosure.fromExport(
            JSON.parse(JSON.stringify(disclosure.export()))
        );
        expect(await imported.verify(output)).toEqual({ kind: "note", note });
        expect(disclosure.getScope().method).toBe("opening");
    });

    it("retains only the shared-key hash in a Credit opening", async () => {
        const disclosure = await core.Disclosure.fromCredit(credit);
        const exported = disclosure.export();
        const text = JSON.stringify(exported);
        expect(text).not.toContain('"creditSharedKey":');
        expect(text).not.toContain("ReceivingKeys");
        const { creditSharedKey, ...opening } = credit;
        const expected = {
            ...opening,
            creditSharedKeyHash: await core.computeCreditSharedKeyHash(creditSharedKey),
        };
        expect(await (await core.Disclosure.fromExport(exported)).verify(creditOutput)).toEqual({
            kind: "credit",
            note: expected,
        });
        expect(disclosure.getScope().revealsCreditSharedKey).toBe(false);
    });

    it("discloses an existing note envelope without exporting the wallet viewing key", async () => {
        const disclosure = await viewer.discloseNote(output.ciphertext, output);
        expect(await disclosure.verify(output)).toMatchObject({ kind: "note", note });
        expect(disclosure.getScope().method).toBe("payload-key");
        const text = JSON.stringify(disclosure.export());
        const envelope = Buffer.from(output.ciphertext.slice(2), "hex");
        const ecdh = createECDH("secp256k1");
        ecdh.setPrivateKey(Buffer.from(vectors.owner.viewingPrivateKey.slice(2), "hex"));
        const expectedKey = hkdfSync(
            "sha256",
            ecdh.computeSecret(envelope.subarray(1, 34)),
            envelope.subarray(34, 50),
            Buffer.concat([
                Buffer.from("Invisi.NoteDelivery.v1"),
                envelope.subarray(1, 34),
                ecdh.getPublicKey(undefined, "compressed"),
            ]),
            32
        );
        expect(disclosure.export().data.payloadKey).toBe(
            `0x${Buffer.from(expectedKey).toString("hex")}`
        );
        expect(text).not.toContain(vectors.owner.viewingPrivateKey.slice(2));
        expect(text).not.toContain(output.ciphertext.slice(2));
        expect(await (await core.Disclosure.fromExport(JSON.parse(text))).verify(output)).toEqual({
            kind: "note",
            note: { ...note, payload: new Uint8Array() },
        });
    });

    it.each(["owner", "spender"] as const)(
        "discloses only the selected Credit %s envelope",
        async (role) => {
            const ownerAddress =
                role === "owner" ? credit.ownerWalletIdentity : credit.spenderWalletIdentity;
            const localViewer = new core.ViewingCapability(
                ownerAddress,
                vectors[role].viewingPrivateKey as `0x${string}`
            );
            const selected = {
                ...creditOutput,
                role,
                ciphertext: vectors.credit[`${role}Ciphertext`] as `0x${string}`,
            };
            const disclosure = await localViewer.discloseCredit(selected.ciphertext, selected);
            const result = await disclosure.verify(selected);
            expect(result.kind).toBe("credit");
            if (result.kind !== "credit") throw Error("Credit disclosure expected");
            expect(result.note.totalSpent).toBe(credit.totalSpent);
            expect("creditSharedKey" in result.note).toBe(false);
            expect(disclosure.getScope().revealsCreditSharedKey).toBe(true);
            expect(disclosure.getScope().revealsReceivingKeys).toBe(true);
            await expect(
                disclosure.verify({ ...selected, role: role === "owner" ? "spender" : "owner" })
            ).rejects.toThrow();
        }
    );

    it("rejects changed context, amount, nonce, hash and out-of-field inputs", async () => {
        const opening = await core.Disclosure.fromNote(note);
        for (const changed of [
            { ...output, chainId: context.chainId + 1n },
            { ...output, protocolAddress: context.protocolAddress + 1n },
            { ...output, tokenAddress: context.tokenAddress + 1n },
            { ...output, outputCommitment: hex(1) },
            { ...output, role: "owner" as const },
        ])
            await expect(opening.verify(changed)).rejects.toThrow();
        for (const changed of [
            { ...note, amount: note.amount + 1n },
            { ...note, nonce: note.nonce + 1n },
        ])
            await expect(
                (await core.Disclosure.fromNote(changed)).verify(output)
            ).rejects.toThrow();
        for (const changed of [
            { ...note, amount: 0n },
            { ...note, nonce: core.FIELD_MODULUS },
            { ...note, ownerAddress: ownerHex(core.FIELD_MODULUS) },
            { ...note, protocolAddress: -1n },
        ])
            await expect(core.Disclosure.fromNote(changed)).rejects.toThrow();
        const material = (await core.Disclosure.fromCredit(credit)).export();
        const tampered = JSON.parse(JSON.stringify(material));
        tampered.data.creditSharedKeyHash = hex(1);
        await expect(core.Disclosure.fromExport(tampered)).rejects.toThrow();
    });

    it("rejects bad ciphertext, wrong viewing keys and missing envelopes for payload disclosure", async () => {
        const disclosure = await viewer.discloseNote(output.ciphertext, output);
        await expect(disclosure.verify({ ...output, ciphertext: undefined })).rejects.toThrow();
        const broken =
            `${output.ciphertext.slice(0, -2)}${output.ciphertext.endsWith("00") ? "01" : "00"}` as `0x${string}`;
        await expect(disclosure.verify({ ...output, ciphertext: broken })).rejects.toThrow();
        await expect(viewer.discloseNote(broken, output)).rejects.toThrow();
        const wrongViewer = new core.ViewingCapability(note.ownerAddress, hex(321));
        await expect(wrongViewer.discloseNote(output.ciphertext, output)).rejects.toThrow();
    });

    it("cannot reuse a disclosed key for another output to the same wallet", async () => {
        const disclosure = await viewer.discloseNote(output.ciphertext, output);
        const another = await core.encryptPrivateTransferNote(viewer.getPublicKey(), note, output);
        await expect(disclosure.verify({ ...output, ciphertext: another })).rejects.toThrow();
    });

    it("redacts implicit JSON and inspection, and snapshots caller data across awaits", async () => {
        const mutable = { ...note };
        const creating = core.Disclosure.fromNote(mutable);
        mutable.amount = 999n;
        const disclosure = await creating;
        expect(await disclosure.verify(output)).toMatchObject({ kind: "note", note });
        const exported = disclosure.export();
        (exported.data as Record<string, unknown>).amount = "999";
        expect(await disclosure.verify(output)).toMatchObject({ kind: "note", note });
        const keyed = await viewer.discloseNote(output.ciphertext, output);
        const secret = (keyed.export().data as Record<string, unknown>).payloadKey;
        expect(typeof secret).toBe("string");
        expect(JSON.stringify(keyed)).not.toContain(secret as string);
        expect(inspect(keyed)).not.toContain(secret as string);
        expect(JSON.stringify(disclosure)).not.toContain("ownerAddress");
    });

    it("strictly rejects unsupported exports, unexpected secrets and noncanonical numbers", async () => {
        const material = (await core.Disclosure.fromNote(note)).export();
        for (const changed of [
            { ...material, version: 2 },
            { ...material, method: "wallet-key" },
            { ...material, data: { ...material.data, viewingPrivateKey: hex(1) } },
            { ...material, data: { ...material.data, amount: "01" } },
            { ...material, data: { ...material.data, nonce: "-1" } },
        ])
            await expect(core.Disclosure.fromExport(changed)).rejects.toThrow();
    });
});

function ownerHex(value: string | number | bigint): `0x${string}` {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}
