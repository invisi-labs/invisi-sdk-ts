import { createECDH, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as core from "./index";
const hexToBytes = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text.slice(2), "hex"));

import vectors from "./testdata/wallet-note-vectors.json";

// Retired protocol 699c2d7 ciphertexts are retained only as rejection fixtures.
const legacyOrdinaryVector =
    "0x0103906664fc1671f662371d2ac838eaab7c63c252ab3c243c2bdc3d1bff8a4cdef001010101010101010101010101010101020202020202020202020202488618ec5419e941d3e38c33ebca016b960676d3c8345faa5dcb47543e1e3b375e0d6c25e79c00186c15ec8961ca3d27baea9ccefbf022e0ecf79e35ea855485ec334ba69f462a728f8a6af049ab45c16af5decbee2f5c43994b4fdbc70f91b9a4db5c1013b88ccf6ebcef37d1f3f1bfb2ed63d2" as const;
const legacyCreditVector =
    "0x0203906664fc1671f662371d2ac838eaab7c63c252ab3c243c2bdc3d1bff8a4cdef001010101010101010101010101010101020202020202020202020202e23b7fdf514b33329fe15525c21e40e3080524242972501a6f316683c0fd09b97d14efeefcb7d67306dbc2e7cb4578e9e7680e9c611aaa4438a2db210cba6b639d110218344899f1901f498a850dda56144fb8f5229b352329cf6fa81a0e22a40a332048924118607d281ad77a636a8e928c4c8bc2226810d104a1856318c9acf8cd2bb800fa6385305327ed05db2c03453f30ba5698106d268c251b6165c994308c5a01b519c39e874b28fdd8aaf25302d379d9742450fd9ebab00ab2e8a2c3" as const;
const bytes = (n: bigint, length = 32) =>
    Buffer.from(n.toString(16).padStart(length * 2, "0"), "hex");
const hex = (n: bigint): `0x${string}` => `0x${bytes(n).toString("hex")}`;
const ordinaryVector = vectors.note.ciphertext as `0x${string}`;
const creditVector = vectors.credit.ownerCiphertext as `0x${string}`;
const key = Buffer.from(vectors.owner.viewingPrivateKey.slice(2), "hex");
const viewingKey = Buffer.from(vectors.owner.viewingPublicKey.slice(2), "hex");
const context = {
    chainId: BigInt(vectors.context.chainId),
    protocolAddress: BigInt(vectors.context.protocolAddress),
    tokenAddress: BigInt(vectors.context.tokenAddress),
};
const payment: core.Note = {
    ...context,
    walletIdentity: ownerHex(BigInt(vectors.note.walletIdentity)),
    amount: BigInt(vectors.note.amount),
    nonce: BigInt(vectors.note.nonce),
};
const noteContext = {
    ...context,
    outputCommitment: vectors.note.commitment as `0x${string}`,
    walletIdentity: payment.walletIdentity,
};
const credit: core.CreditNote = {
    ...context,
    spenderWalletIdentity: ownerHex(BigInt(vectors.credit.spenderWalletIdentity)),
    ownerWalletIdentity: ownerHex(BigInt(vectors.credit.ownerWalletIdentity)),
    spenderPayout: BigInt(vectors.credit.spenderPayout),
    ownerPayout: BigInt(vectors.credit.ownerPayout),
    amount: BigInt(vectors.credit.amount),
    nonce: BigInt(vectors.credit.nonce),
    expiry: BigInt(vectors.credit.expiry),
    creditSharedKey: BigInt(vectors.credit.creditSharedKey),
};
const creditContext = {
    ...context,
    outputCommitment: vectors.credit.commitment as `0x${string}`,
    walletIdentity: credit.ownerWalletIdentity,
    role: "owner" as const,
};
const receivingKeys = (role: "owner" | "spender") => ({
    viewingPublicKey: hexToBytes(
        vectors.credit[`${role}ReceivingKeys`].viewingPublicKey as `0x${string}`
    ),
    clueKey: hexToBytes(vectors.credit[`${role}ReceivingKeys`].clueKey as `0x${string}`),
});
const creditState: core.CreditDeliveryState = {
    note: credit,
    ownerReceivingKeys: receivingKeys("owner"),
    spenderReceivingKeys: receivingKeys("spender"),
};
type ReferenceContext = core.NoteDecryptionContext & { role?: "owner" | "spender" };

// Independent reference codec uses Node crypto only; production uses WebCrypto.
function referenceAAD(version: number, c: ReferenceContext, header: Uint8Array) {
    return Buffer.concat([
        Buffer.from(version === 2 ? "Invisi.NoteDelivery.v2" : "Invisi.CreditDelivery.v2"),
        header,
        Buffer.from([version === 2 ? 0 : c.role === "owner" ? 1 : 2]),
        bytes(c.chainId, 8),
        bytes(c.protocolAddress, 20),
        bytes(c.tokenAddress, 20),
        bytes(BigInt(c.outputCommitment)),
    ]);
}
function referencePlaintext(envelope: Uint8Array, c: ReferenceContext, privateKey = key) {
    const data = Buffer.from(envelope),
        version = data[0]!,
        ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(privateKey);
    const domain = Buffer.from(
        version === 2 ? "Invisi.NoteDelivery.v2" : "Invisi.CreditDelivery.v2"
    );
    const info = Buffer.concat([
        domain,
        data.subarray(1, 34),
        ecdh.getPublicKey(undefined, "compressed"),
    ]);
    const derived = hkdfSync(
        "sha256",
        ecdh.computeSecret(data.subarray(1, 34)),
        data.subarray(34, 50),
        info,
        32
    );
    const cipher = createDecipheriv("aes-256-gcm", Buffer.from(derived), data.subarray(50, 62));
    cipher.setAAD(referenceAAD(version, c, data.subarray(0, 62)));
    cipher.setAuthTag(data.subarray(data.length - 16));
    return Buffer.concat([cipher.update(data.subarray(62, data.length - 16)), cipher.final()]);
}
function referenceSeal(plain: Uint8Array, version: number, c: ReferenceContext) {
    const ecdh = createECDH("secp256k1");
    ecdh.setPrivateKey(bytes(901n));
    const salt = Buffer.alloc(16, 3),
        iv = Buffer.alloc(12, 4);
    const ephemeralPublicKey = ecdh.getPublicKey(undefined, "compressed");
    const header = Buffer.concat([Buffer.from([version]), ephemeralPublicKey, salt, iv]);
    const domain = Buffer.from(
        version === 2 ? "Invisi.NoteDelivery.v2" : "Invisi.CreditDelivery.v2"
    );
    const info = Buffer.concat([domain, ephemeralPublicKey, viewingKey]);
    const derived = hkdfSync("sha256", ecdh.computeSecret(viewingKey), salt, info, 32);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(derived), iv);
    cipher.setAAD(referenceAAD(version, c, header));
    return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}
const notePlaintext = Buffer.concat([
    bytes(BigInt(payment.walletIdentity)),
    bytes(payment.amount, 16),
    bytes(payment.nonce),
    bytes(0n, 2),
]);
const creditPlaintext = Buffer.concat([
    bytes(BigInt(credit.spenderWalletIdentity)),
    bytes(BigInt(credit.ownerWalletIdentity)),
    bytes(credit.spenderPayout, 20),
    bytes(credit.ownerPayout, 20),
    bytes(credit.amount, 16),
    bytes(credit.nonce),
    bytes(credit.expiry, 8),
    bytes(credit.creditSharedKey),
    creditState.ownerReceivingKeys.viewingPublicKey,
    creditState.ownerReceivingKeys.clueKey,
    creditState.spenderReceivingKeys.viewingPublicKey,
    creditState.spenderReceivingKeys.clueKey,
    bytes(0n, 2),
]);
const decryptionCases: ReadonlyArray<
    readonly [
        core.NoteBytes,
        ReferenceContext,
        (
            key: core.NoteBytes,
            envelope: core.NoteBytes,
            context: ReferenceContext
        ) => Promise<core.Note | core.CreditDeliveryState>,
    ]
> = [
    [ordinaryVector, noteContext, core.decryptPrivateTransferNote],
    [
        creditVector,
        creditContext,
        (key, envelope, c) => core.decryptCreditNote(key, envelope, { ...c, role: c.role! }),
    ],
];

describe("current authenticated note envelopes", () => {
    it("derives the protocol compressed viewing public key", () => {
        expect(Buffer.from(core.viewingPublicKey(key))).toEqual(viewingKey);
    });
    it("decrypts the protocol ordinary envelope vector", async () => {
        expect(await core.decryptPrivateTransferNote(key, ordinaryVector, noteContext)).toEqual(
            payment
        );
    });
    it("decrypts the protocol Credit envelope vector", async () => {
        expect(await core.decryptCreditNote(key, creditVector, creditContext)).toEqual(creditState);
    });
    it("matches the current Credit commitment and complete 324-byte binary payload", async () => {
        expect(
            await core.computeCreditCommitment(
                context.chainId,
                credit.spenderWalletIdentity,
                credit.ownerWalletIdentity,
                credit.spenderPayout,
                credit.ownerPayout,
                credit.tokenAddress,
                credit.amount,
                credit.nonce,
                credit.expiry,
                await core.computeCreditSharedKeyHash(credit.creditSharedKey)
            )
        ).toBe(creditContext.outputCommitment);
        expect(
            referencePlaintext(Buffer.from(creditVector.slice(2), "hex"), creditContext)
        ).toEqual(creditPlaintext);
        expect(creditPlaintext).toHaveLength(324);
        expect(await core.decryptCreditNote(key, creditVector, creditContext)).not.toHaveProperty(
            "merchantIdentityCommitment"
        );
    });
    it("rejects the removed merchant and identity commitment note keys", async () => {
        const { spenderWalletIdentity, ...fields } = credit;
        for (const legacyNote of [
            { ...fields, merchantIdentityCommitment: spenderWalletIdentity },
            { ...fields, spenderIdentityCommitment: spenderWalletIdentity },
        ])
            await expect(
                core.encryptCreditNote(
                    viewingKey,
                    { ...creditState, note: legacyNote as unknown as core.CreditNote },
                    creditContext
                )
            ).rejects.toThrow();
    });
    it("creates interoperable randomized ordinary envelopes", async () => {
        const a = await core.encryptPrivateTransferNote(viewingKey, payment, noteContext);
        const b = await core.encryptPrivateTransferNote(viewingKey, payment, noteContext);
        expect(a).toHaveLength(160);
        expect(a[0]).toBe(2);
        expect(a).not.toEqual(b);
        expect(referencePlaintext(a, noteContext)).toEqual(notePlaintext);
        expect(await core.decryptPrivateTransferNote(key, a, noteContext)).toEqual(payment);
    });
    it("creates interoperable Credit envelopes containing both roles, payouts and the shared secret", async () => {
        const a = await core.encryptCreditNote(viewingKey, creditState, creditContext);
        const b = await core.encryptCreditNote(viewingKey, creditState, creditContext);
        expect(a).toHaveLength(402);
        expect(a[0]).toBe(4);
        expect(a).not.toEqual(b);
        expect(referencePlaintext(a, creditContext)).toEqual(creditPlaintext);
        expect(await core.decryptCreditNote(key, a, creditContext)).toEqual(creditState);
    });
    it("rejects wrong keys, deployment/token/chain context and output commitment", async () => {
        for (const [vector, c, decrypt] of decryptionCases) {
            await expect(decrypt(bytes(501n), vector, c)).rejects.toThrow();
            for (const wrong of [
                { ...c, chainId: 2n },
                { ...c, protocolAddress: c.protocolAddress + 1n },
                { ...c, tokenAddress: c.tokenAddress + 1n },
                { ...c, outputCommitment: hex(1n) },
            ]) {
                await expect(decrypt(key, vector, wrong)).rejects.toThrow();
            }
        }
    });
    it("encrypts using the note and context captured at entry", async () => {
        const mutableNote = { ...payment },
            mutableContext = { ...noteContext };
        const pendingNote = core.encryptPrivateTransferNote(
            viewingKey,
            mutableNote,
            mutableContext
        );
        mutableContext.protocolAddress += 1n;
        mutableNote.protocolAddress += 1n;
        mutableNote.walletIdentity = hex(1n);
        const envelope = await pendingNote;
        await expect(core.decryptPrivateTransferNote(key, envelope, noteContext)).resolves.toEqual(
            payment
        );

        const mutableCredit = structuredClone(creditState),
            mutableCreditContext: core.CreditNoteDecryptionContext = { ...creditContext };
        const pendingCredit = core.encryptCreditNote(
            viewingKey,
            mutableCredit,
            mutableCreditContext
        );
        mutableCreditContext.protocolAddress += 1n;
        mutableCreditContext.role = "spender";
        mutableCreditContext.walletIdentity = hex(1n);
        mutableCredit.note.protocolAddress += 1n;
        mutableCredit.note.ownerPayout += 1n;
        mutableCredit.note.ownerWalletIdentity = hex(1n);
        const creditEnvelope = await pendingCredit;
        await expect(core.decryptCreditNote(key, creditEnvelope, creditContext)).resolves.toEqual(
            creditState
        );
    });
    it("returns the context authenticated at decryption entry despite caller mutation", async () => {
        const mutableNoteContext = { ...noteContext };
        const pendingNote = core.decryptPrivateTransferNote(
            key,
            ordinaryVector,
            mutableNoteContext
        );
        mutableNoteContext.protocolAddress += 1n;
        mutableNoteContext.walletIdentity = hex(1n);
        await expect(pendingNote).resolves.toEqual(payment);

        const mutableCreditContext: core.CreditNoteDecryptionContext = { ...creditContext };
        const pendingCredit = core.decryptCreditNote(key, creditVector, mutableCreditContext);
        mutableCreditContext.protocolAddress += 1n;
        mutableCreditContext.role = "spender";
        mutableCreditContext.walletIdentity = hex(1n);
        await expect(pendingCredit).resolves.toEqual(creditState);
    });
    it("rejects note contexts that differ from the authenticated envelope context", async () => {
        for (const [note, c, encrypt] of [
            [
                payment,
                noteContext,
                (k: core.NoteBytes, n: core.Note, c: ReferenceContext) =>
                    core.encryptPrivateTransferNote(k, n, c),
            ],
            [
                credit,
                creditContext,
                (k: core.NoteBytes, n: core.CreditNote, c: ReferenceContext) =>
                    core.encryptCreditNote(k, { ...creditState, note: n }, { ...c, role: c.role! }),
            ],
        ] as const) {
            for (const wrong of [
                { ...note, chainId: note.chainId + 1n },
                { ...note, protocolAddress: note.protocolAddress + 1n },
            ]) {
                await expect(
                    encrypt(viewingKey, wrong as typeof payment & typeof credit, c)
                ).rejects.toThrow();
            }
            const { chainId, protocolAddress, ...unscoped } = note;
            await expect(
                encrypt(viewingKey, unscoped as typeof payment & typeof credit, c)
            ).rejects.toThrow();
        }
    });
    it("rejects corrupted header, ciphertext and authentication tag", async () => {
        for (const [vector, c, decrypt] of decryptionCases) {
            for (const position of [
                ...Array.from({ length: 62 }, (_, i) => i),
                62,
                100,
                ((vector as string).length - 2) / 2 - 1,
            ]) {
                const corrupted = Buffer.from((vector as string).slice(2), "hex");
                corrupted[position] = corrupted[position]! ^ 1;
                await expect(decrypt(key, corrupted, c)).rejects.toThrow();
            }
        }
    });
    it("authenticates the complete header including ephemeral point parity for both envelope versions", async () => {
        // Point negation preserves raw-X ECDH, so this specifically proves header AAD binding.
        for (const [vector, c, decrypt] of decryptionCases) {
            const data = Buffer.from((vector as string).slice(2), "hex");
            data[1] = data[1]! ^ 1;
            await expect(decrypt(key, data, c)).rejects.toThrow();
        }
    });
    it("rejects retired ciphertext lengths instead of accepting old formats", async () => {
        await expect(
            core.decryptPrivateTransferNote(key, legacyOrdinaryVector, noteContext)
        ).rejects.toThrow();
        await expect(
            core.decryptCreditNote(key, legacyCreditVector, creditContext)
        ).rejects.toThrow();
    });
    it("rejects unsupported versions, malformed bytes and envelope lengths", async () => {
        for (const [vector, c, decrypt] of decryptionCases) {
            const data = Buffer.from((vector as string).slice(2), "hex");
            data[0] = 99;
            await expect(decrypt(key, data, c)).rejects.toThrow();
            await expect(decrypt(key, data.subarray(1), c)).rejects.toThrow();
            await expect(decrypt(key, "0xzz", c)).rejects.toThrow();
        }
        expect(() => core.viewingPublicKey(bytes(0n))).toThrow();
        expect(() => core.viewingPublicKey(new Uint8Array(31))).toThrow();
    });
    it("rejects encryption with mismatched commitments and invalid viewing keys", async () => {
        await expect(
            core.encryptPrivateTransferNote(viewingKey, payment, {
                ...noteContext,
                outputCommitment: hex(1n),
            })
        ).rejects.toThrow();
        await expect(
            core.encryptCreditNote(viewingKey, creditState, {
                ...creditContext,
                outputCommitment: hex(1n),
            })
        ).rejects.toThrow();
        await expect(
            core.encryptPrivateTransferNote(new Uint8Array(33), payment, noteContext)
        ).rejects.toThrow();
        await expect(
            core.encryptCreditNote(new Uint8Array(33), creditState, creditContext)
        ).rejects.toThrow();
    });
    it("rejects authenticated memo length mismatches, trailing data, overflow and missing framing", async () => {
        for (const [plain, version, c, decrypt] of [
            [notePlaintext, 2, noteContext, core.decryptPrivateTransferNote],
            [creditPlaintext, 4, creditContext, core.decryptCreditNote],
        ] as const) {
            const base = plain.subarray(0, plain.length - 2);
            for (const malformed of [
                base,
                Buffer.concat([base, bytes(1n, 2)]),
                Buffer.concat([base, bytes(0n, 2), Buffer.from([1])]),
                Buffer.concat([base, bytes(257n, 2), Buffer.alloc(257)]),
            ]) {
                await expect(
                    decrypt(
                        key,
                        referenceSeal(malformed, version, c),
                        c as core.CreditNoteDecryptionContext
                    )
                ).rejects.toThrow();
            }
        }
    });
    it("rejects authenticated plaintext when its note fails the output commitment", async () => {
        const changedNote = Buffer.from(notePlaintext);
        changedNote[47] = changedNote[47]! ^ 1;
        const changedCredit = Buffer.from(creditPlaintext);
        changedCredit[119] = changedCredit[119]! ^ 1;
        await expect(
            core.decryptPrivateTransferNote(
                key,
                referenceSeal(changedNote, 2, noteContext),
                noteContext
            )
        ).rejects.toThrow();
        await expect(
            core.decryptCreditNote(
                key,
                referenceSeal(changedCredit, 4, creditContext),
                creditContext
            )
        ).rejects.toThrow();
    });
    it("rejects authenticated plaintext with invalid field/range values", async () => {
        const invalidNote = Buffer.from(notePlaintext);
        bytes(core.FIELD_MODULUS).copy(invalidNote, 48);
        const invalidCredit = Buffer.from(creditPlaintext);
        bytes(0n).copy(invalidCredit, 160);
        await expect(
            core.decryptPrivateTransferNote(
                key,
                referenceSeal(invalidNote, 2, noteContext),
                noteContext
            )
        ).rejects.toThrow();
        await expect(
            core.decryptCreditNote(
                key,
                referenceSeal(invalidCredit, 4, creditContext),
                creditContext
            )
        ).rejects.toThrow();
        await expect(
            core.encryptPrivateTransferNote(
                viewingKey,
                { ...payment, amount: 1n << 128n },
                noteContext
            )
        ).rejects.toThrow();
        await expect(
            core.encryptCreditNote(
                viewingKey,
                { ...creditState, note: { ...credit, amount: 1n << 126n } },
                creditContext
            )
        ).rejects.toThrow();
    });
    it("opens independent Node crypto envelopes in WebCrypto", async () => {
        expect(
            referencePlaintext(Buffer.from(ordinaryVector.slice(2), "hex"), noteContext)
        ).toEqual(notePlaintext);
        await expect(
            core.decryptPrivateTransferNote(
                key,
                referenceSeal(notePlaintext, 2, noteContext),
                noteContext
            )
        ).resolves.toEqual(payment);
        await expect(
            core.decryptCreditNote(
                key,
                referenceSeal(creditPlaintext, 4, creditContext),
                creditContext
            )
        ).resolves.toEqual(creditState);
    });
    it("opens and produces interoperable Credit envelopes for the spender role", async () => {
        const spenderKey = Buffer.from(vectors.spender.viewingPrivateKey.slice(2), "hex");
        const spenderPublicKey = Buffer.from(vectors.spender.viewingPublicKey.slice(2), "hex");
        const spenderContext = {
            ...creditContext,
            role: "spender" as const,
            walletIdentity: credit.spenderWalletIdentity,
        };
        expect(Buffer.from(core.viewingPublicKey(spenderKey))).toEqual(spenderPublicKey);
        await expect(
            core.decryptCreditNote(
                spenderKey,
                vectors.credit.spenderCiphertext as `0x${string}`,
                spenderContext
            )
        ).resolves.toEqual(creditState);
        const generated = await core.encryptCreditNote(
            spenderPublicKey,
            creditState,
            spenderContext
        );
        expect(referencePlaintext(generated, spenderContext, spenderKey)).toEqual(creditPlaintext);
        await expect(
            core.decryptCreditNote(spenderKey, generated, spenderContext)
        ).resolves.toEqual(creditState);
    });
    it("requires the expected recipient wallet identity for funds and Credit", async () => {
        for (const [vector, c, decrypt] of decryptionCases) {
            await expect(
                decrypt(key, vector, {
                    ...c,
                    walletIdentity: ownerHex(BigInt(c.walletIdentity) + 1n),
                })
            ).rejects.toThrow();
            const { walletIdentity, ...withoutIdentity } = c;
            await expect(
                decrypt(key, vector, withoutIdentity as ReferenceContext)
            ).rejects.toThrow();
        }
        const misdirected = await core.encryptPrivateTransferNote(viewingKey, payment, noteContext);
        await expect(
            core.decryptPrivateTransferNote(key, misdirected, {
                ...noteContext,
                walletIdentity: credit.spenderWalletIdentity,
            })
        ).rejects.toThrow();
    });
    it("prevents owner/spender redirection and rejects missing or invalid Credit roles", async () => {
        await expect(
            core.decryptCreditNote(key, creditVector, {
                ...creditContext,
                role: "spender",
                walletIdentity: credit.spenderWalletIdentity,
            })
        ).rejects.toThrow();
        await expect(
            core.decryptCreditNote(
                vectors.spender.viewingPrivateKey as `0x${string}`,
                vectors.credit.spenderCiphertext as `0x${string}`,
                { ...creditContext, role: "owner" }
            )
        ).rejects.toThrow();
        for (const role of [undefined, "merchant", ""]) {
            const invalidContext = {
                ...creditContext,
                role,
            } as unknown as core.CreditNoteDecryptionContext;
            await expect(
                core.decryptCreditNote(key, creditVector, invalidContext)
            ).rejects.toThrow();
            await expect(
                core.encryptCreditNote(viewingKey, creditState, invalidContext)
            ).rejects.toThrow();
        }
    });
    it("rejects authenticated changes to either payout or wallet role", async () => {
        // Re-seal with a valid tag so the rejection must also validate plaintext semantics.
        for (const offset of [31, 63, 83, 103]) {
            const changed = Buffer.from(creditPlaintext);
            changed[offset] = changed[offset]! ^ 1;
            await expect(
                core.decryptCreditNote(key, referenceSeal(changed, 4, creditContext), creditContext)
            ).rejects.toThrow();
        }
        for (const changed of [
            { ...credit, spenderPayout: credit.spenderPayout + 1n },
            { ...credit, ownerPayout: credit.ownerPayout + 1n },
        ]) {
            await expect(
                core.encryptCreditNote(viewingKey, { ...creditState, note: changed }, creditContext)
            ).rejects.toThrow();
        }
    });
    it("validates authenticated note and Credit scalar ranges before returning data", async () => {
        for (const [offset, value, length] of [
            [0, 0n, 32],
            [0, core.FIELD_MODULUS, 32],
            [32, 0n, 16],
            [48, core.FIELD_MODULUS, 32],
        ] as const) {
            const invalid = Buffer.from(notePlaintext);
            bytes(value, length).copy(invalid, offset);
            await expect(
                core.decryptPrivateTransferNote(
                    key,
                    referenceSeal(invalid, 2, noteContext),
                    noteContext
                )
            ).rejects.toThrow();
        }
        for (const [offset, value, length] of [
            [0, 0n, 32],
            [32, core.FIELD_MODULUS, 32],
            [64, 0n, 20],
            [84, 0n, 20],
            [104, 0n, 16],
            [104, 1n << 126n, 16],
            [120, core.FIELD_MODULUS, 32],
            [152, 0n, 8],
            [160, core.FIELD_MODULUS, 32],
        ] as const) {
            const invalid = Buffer.from(creditPlaintext);
            bytes(value, length).copy(invalid, offset);
            await expect(
                core.decryptCreditNote(key, referenceSeal(invalid, 4, creditContext), creditContext)
            ).rejects.toThrow();
        }
    });
    it("enforces chain, protocol, token, output commitment and note boundaries on encryption", async () => {
        for (const changed of [
            { ...noteContext, chainId: -1n },
            { ...noteContext, chainId: 1n << 64n },
            { ...noteContext, protocolAddress: -1n },
            { ...noteContext, protocolAddress: 1n << 160n },
            { ...noteContext, outputCommitment: hex(core.FIELD_MODULUS) },
        ]) {
            await expect(
                core.encryptPrivateTransferNote(viewingKey, payment, changed)
            ).rejects.toThrow();
        }
        for (const changed of [
            { ...payment, walletIdentity: ownerHex(0n) },
            { ...payment, walletIdentity: ownerHex(core.FIELD_MODULUS) },
            { ...payment, tokenAddress: 1n << 160n },
            { ...payment, tokenAddress: -1n },
            { ...payment, amount: 0n },
            { ...payment, nonce: -1n },
            { ...payment, nonce: core.FIELD_MODULUS },
        ]) {
            await expect(
                core.encryptPrivateTransferNote(viewingKey, changed, noteContext)
            ).rejects.toThrow();
        }
        for (const changed of [
            { ...credit, spenderWalletIdentity: ownerHex(0n) },
            { ...credit, ownerWalletIdentity: ownerHex(core.FIELD_MODULUS) },
            { ...credit, spenderPayout: -1n },
            { ...credit, ownerPayout: 1n << 160n },
            { ...credit, amount: 0n },
            { ...credit, expiry: 0n },
            { ...credit, expiry: 1n << 64n },
            { ...credit, nonce: core.FIELD_MODULUS },
            { ...credit, creditSharedKey: 0n },
        ]) {
            await expect(
                core.encryptCreditNote(viewingKey, { ...creditState, note: changed }, creditContext)
            ).rejects.toThrow();
        }
    });
    it("rejects malformed, uncompressed, and off-curve viewing keys", async () => {
        const ecdh = createECDH("secp256k1");
        ecdh.setPrivateKey(key);
        for (const publicKey of [
            new Uint8Array(32),
            ecdh.getPublicKey(undefined, "uncompressed"),
            Buffer.concat([Buffer.from([2]), Buffer.alloc(32, 255)]),
            "0xzz" as const,
        ]) {
            await expect(
                core.encryptPrivateTransferNote(publicKey, payment, noteContext)
            ).rejects.toThrow();
            await expect(
                core.encryptCreditNote(publicKey, creditState, creditContext)
            ).rejects.toThrow();
        }
        for (const privateKey of [
            bytes(0n),
            Buffer.alloc(32, 255),
            new Uint8Array(31),
            "0xzz" as const,
        ]) {
            expect(() => core.viewingPublicKey(privateKey)).toThrow();
            await expect(
                core.decryptPrivateTransferNote(privateKey, ordinaryVector, noteContext)
            ).rejects.toThrow();
            await expect(
                core.decryptCreditNote(privateKey, creditVector, creditContext)
            ).rejects.toThrow();
        }
    });
});

function ownerHex(value: string | number | bigint): `0x${string}` {
    return `0x${BigInt(value).toString(16).padStart(40, "0")}`;
}
