import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { describe, it, expect } from "vitest";
import * as core from "../index";
import legacyCredit from "./testdata/previous-credit-envelope.json";
import vectors from "../wallet/testdata/wallet-note-vectors.json";
const bytes = (s: string) => Uint8Array.from(Buffer.from(s.slice(2), "hex"));
const address = (s: string) => `0x${BigInt(s).toString(16).padStart(40, "0")}` as `0x${string}`;
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
    tokenAddress: BigInt(vectors.context.tokenAddress),
};
const note: core.Note = {
    ...context,
    ownerAddress: address(vectors.note.ownerAddress),
    amount: BigInt(vectors.note.amount),
    nonce: BigInt(vectors.note.nonce),
    payload: new Uint8Array(),
};
const credit: core.CreditState = {
    ...context,
    ...Object.fromEntries(
        Object.entries(vectors.credit)
            .filter(([k]) =>
                [
                    "spenderWalletIdentity",
                    "ownerWalletIdentity",
                    "grantId",
                    "nonce",
                    "expiry",
                    "creditSharedKey",
                    "singleLimit",
                    "dailyLimit",
                    "monthlyLimit",
                    "availableCredit",
                    "unlimited",
                    "lastDay",
                    "dailySpent",
                    "lastMonth",
                    "monthlySpent",
                    "totalSpent",
                ].includes(k)
            )
            .map(([k, v]) => [
                k,
                k === "unlimited"
                    ? v
                    : k.endsWith("Identity")
                      ? address(v as string)
                      : BigInt(v as string),
            ])
    ),
    payload: new Uint8Array(),
} as core.CreditState;
const keys = (role: "owner" | "spender") => ({
    viewingPublicKey: bytes(vectors.credit[`${role}ReceivingKeys`].viewingPublicKey),
    clueKey: bytes(vectors.credit[`${role}ReceivingKeys`].clueKey),
});
const state: core.CreditDeliveryState = {
    note: credit,
    ownerReceivingKeys: keys("owner"),
    spenderReceivingKeys: keys("spender"),
};
const nc = {
    ...context,
    ownerAddress: note.ownerAddress,
    outputCommitment: vectors.note.commitment as `0x${string}`,
};
const cc = (role: "owner" | "spender") => ({
    ...context,
    ownerAddress: role === "owner" ? credit.ownerWalletIdentity : credit.spenderWalletIdentity,
    outputCommitment: vectors.credit.commitment as `0x${string}`,
    role,
});
const word = (n: bigint, size: number) =>
    Buffer.from(n.toString(16).padStart(size * 2, "0"), "hex");
function independentlyOpen(envelope: Uint8Array, role: "owner" | "spender") {
    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(bytes(vectors[role].viewingPrivateKey));
    const header = envelope.subarray(0, 62),
        domain = Buffer.from("Invisi.CreditDelivery.v4.GrantId.Uint128");
    const key = hkdfSync(
        "sha256",
        ecdh.computeSecret(envelope.subarray(1, 34)),
        envelope.subarray(34, 50),
        Buffer.concat([
            domain,
            envelope.subarray(1, 34),
            ecdh.getPublicKey(undefined, "compressed"),
        ]),
        32
    );
    const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key), envelope.subarray(50, 62));
    cipher.setAAD(
        Buffer.concat([
            domain,
            header,
            Buffer.from([role === "owner" ? 1 : 2]),
            word(context.chainId, 8),
            word(context.protocolAddress, 20),
            word(context.tokenAddress, 20),
            bytes(vectors.credit.commitment),
        ])
    );
    cipher.setAuthTag(envelope.subarray(envelope.length - 16));
    return Buffer.concat([cipher.update(envelope.subarray(62, -16)), cipher.final()]);
}
describe("current authenticated delivery envelopes", () => {
    it("opens the independent ordinary Note vector", async () => {
        expect(
            await core.decryptPrivateTransferNote(
                bytes(vectors.owner.viewingPrivateKey),
                vectors.note.ciphertext as `0x${string}`,
                nc
            )
        ).toEqual(note);
    });
    it.each(["owner", "spender"] as const)(
        "opens current protocol Credit vector for %s",
        async (role) => {
            expect(
                await core.decryptCreditState(
                    bytes(vectors[role].viewingPrivateKey),
                    vectors.credit[`${role}Ciphertext`] as `0x${string}`,
                    cc(role)
                )
            ).toEqual(state);
        }
    );
    it.each(["owner", "spender"] as const)(
        "creates independently decryptable Credit v4 for %s",
        async (role) => {
            const envelope = await core.encryptCreditState(
                keys(role).viewingPublicKey,
                state,
                cc(role)
            );
            expect(envelope[0]).toBe(0x84);
            expect(envelope).toHaveLength(491);
            const plain = independentlyOpen(envelope, role);
            expect(plain).toHaveLength(413);
            expect(plain.subarray(64, 80)).toEqual(word(credit.grantId, 16));
            expect(envelope.subarray(475)).toHaveLength(16);
            expect(plain.subarray(-2)).toEqual(Buffer.alloc(2));
            expect(
                await core.decryptCreditState(
                    bytes(vectors[role].viewingPrivateKey),
                    envelope,
                    cc(role)
                )
            ).toEqual(state);
        }
    );
    it("creates randomized ordinary Notes", async () => {
        const a = await core.encryptPrivateTransferNote(
                bytes(vectors.owner.viewingPublicKey),
                note,
                nc
            ),
            b = await core.encryptPrivateTransferNote(
                bytes(vectors.owner.viewingPublicKey),
                note,
                nc
            );
        expect(a).not.toEqual(b);
        expect(a).toHaveLength(160);
        expect(
            await core.decryptPrivateTransferNote(bytes(vectors.owner.viewingPrivateKey), a, nc)
        ).toEqual(note);
    });
    it("authenticates complete header, ciphertext and tag", async () => {
        const original = bytes(vectors.credit.ownerCiphertext);
        for (const offset of [0, 1, 2, 34, 50, 62, original.length - 1]) {
            const bad = original.slice();
            bad[offset] = bad[offset]! ^ 1;
            await expect(
                core.decryptCreditState(bytes(vectors.owner.viewingPrivateKey), bad, cc("owner"))
            ).rejects.toThrow();
        }
    });
    it("binds chain, deployment, token, recipient, role and commitment", async () => {
        for (const changed of [
            { chainId: 1n },
            { protocolAddress: 2n },
            { tokenAddress: 3n },
            { ownerAddress: credit.spenderWalletIdentity },
            { role: "spender" as const },
            { outputCommitment: `0x${"01".repeat(32)}` as `0x${string}` },
        ])
            await expect(
                core.decryptCreditState(
                    bytes(vectors.owner.viewingPrivateKey),
                    vectors.credit.ownerCiphertext as `0x${string}`,
                    { ...cc("owner"), ...changed }
                )
            ).rejects.toThrow();
    });
    it("rejects wrong keys and role redirection on encryption", async () => {
        await expect(
            core.encryptCreditState(keys("spender").viewingPublicKey, state, cc("owner"))
        ).rejects.toThrow();
        await expect(
            core.decryptCreditState(
                bytes(vectors.spender.viewingPrivateKey),
                vectors.credit.ownerCiphertext as `0x${string}`,
                cc("owner")
            )
        ).rejects.toThrow();
    });
    it.each(["owner", "spender"] as const)(
        "rejects prior Credit envelopes for %s",
        async (role) => {
            for (const header of [0x82, 0x83]) {
                const old = bytes(vectors.credit[`${role}Ciphertext`]);
                old[0] = header;
                await expect(
                    core.decryptCreditState(bytes(vectors[role].viewingPrivateKey), old, cc(role))
                ).rejects.toThrow(/version/);
            }
            await expect(
                core.decryptCreditState(
                    bytes(vectors[role].viewingPrivateKey),
                    legacyCredit.envelope as `0x${string}`,
                    cc(role)
                )
            ).rejects.toThrow(/version/);
        }
    );
    it("rejects unsupported Credit envelope versions and unexpected state fields", async () => {
        const malformed = bytes(vectors.credit.ownerCiphertext);
        malformed[0] = 0xff;
        await expect(
            core.decryptCreditState(bytes(vectors.owner.viewingPrivateKey), malformed, cc("owner"))
        ).rejects.toThrow(/version/);
        await expect(
            core.encryptCreditState(
                keys("owner").viewingPublicKey,
                { ...state, note: { ...credit, unexpectedField: 1n } as core.CreditState },
                cc("owner")
            )
        ).rejects.toThrow(/Unsupported Credit fields/);
    });
    it("preserves opaque payload and receiving snapshots, with length limits", async () => {
        const custom = { ...state, note: { ...credit, payload: Uint8Array.from([0, 255, 1, 2]) } },
            envelope = await core.encryptCreditState(
                keys("owner").viewingPublicKey,
                custom,
                cc("owner")
            );
        expect(
            await core.decryptCreditState(
                bytes(vectors.owner.viewingPrivateKey),
                envelope,
                cc("owner")
            )
        ).toEqual(custom);
        await expect(
            core.encryptCreditState(
                keys("owner").viewingPublicKey,
                { ...state, note: { ...credit, payload: new Uint8Array(3613) } },
                cc("owner")
            )
        ).rejects.toThrow();
    });
    it("rejects malformed points and mismatched financial openings", async () => {
        for (const key of [new Uint8Array(33), new Uint8Array(65)])
            await expect(core.encryptPrivateTransferNote(key, note, nc)).rejects.toThrow();
        await expect(
            core.encryptPrivateTransferNote(
                bytes(vectors.owner.viewingPublicKey),
                { ...note, amount: note.amount + 1n },
                nc
            )
        ).rejects.toThrow(/commitment/);
        await expect(
            core.encryptCreditState(
                keys("owner").viewingPublicKey,
                { ...state, note: { ...credit, grantId: 2n } },
                cc("owner")
            )
        ).rejects.toThrow(/commitment/);
    });
});

it.each(["owner", "spender"] as const)(
    "round-trips the maximum uint128 grant ID for %s",
    async (role) => {
        const maximal = { ...state, note: { ...credit, grantId: (1n << 128n) - 1n } };
        const scoped = {
            ...cc(role),
            outputCommitment: await core.computeCreditCommitment(maximal.note),
        };
        const envelope = await core.encryptCreditState(
            keys(role).viewingPublicKey,
            maximal,
            scoped
        );
        expect(
            await core.decryptCreditState(bytes(vectors[role].viewingPrivateKey), envelope, scoped)
        ).toEqual(maximal);
        for (const grantId of [0n, 1n << 128n])
            await expect(
                core.encryptCreditState(
                    keys(role).viewingPublicKey,
                    { ...maximal, note: { ...maximal.note, grantId } },
                    scoped
                )
            ).rejects.toThrow(/grantId/);
    }
);
