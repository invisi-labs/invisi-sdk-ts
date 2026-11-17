/** Refresh public-test funds and Credit envelopes using the actual protocol Node implementation. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const sdk = resolve(import.meta.dirname, "..");
const protocol = resolve(process.argv[2] ?? join(sdk, "../invisi-core"));
const source = join(protocol, "scripts/create-credit-client.mjs");
const { encryptCreditNote, creditCommitment } = await import(pathToFileURL(source).href);
const file = join(sdk, "packages/primitives/src/wallet/testdata/wallet-note-vectors.json");
const vectors = JSON.parse(readFileSync(file, "utf8"));
const clueKey = "0xc69480518ea88f8cb925fbcd8f5100b1ebc46cc4d8cbe19e0478936567e6b211";
const fields = [
    "spenderWalletIdentity",
    "ownerWalletIdentity",
    "revocationShard",
    "revocationSlot",
    "nonce",
    "expiry",
    "creditSharedKey",
    "singleLimit",
    "dailyLimit",
    "monthlyLimit",
    "lastDay",
    "dailySpent",
    "lastMonth",
    "monthlySpent",
    "totalSpent",
];
const note = {
    ...Object.fromEntries(fields.map((field) => [field, BigInt(vectors.credit[field])])),
    availableCredit: 1000000n,
    unlimited: false,
};
const state = {
    note,
    ownerReceivingKeys: { viewingPublicKey: vectors.owner.viewingPublicKey, clueKey },
    spenderReceivingKeys: { viewingPublicKey: vectors.spender.viewingPublicKey, clueKey },
};
const context = {
    ...vectors.context,
    chainId: BigInt(vectors.context.chainId),
    timestamp: BigInt(vectors.context.timestamp),
};
context.outputCommitment = await creditCommitment(context, note);
const { creditNullifier, deriveCreditState, applyCreditDrawUsage, creditPeriods } = await import(
    pathToFileURL(join(protocol, "scripts/credit-lifecycle-client.mjs")).href
);
vectors.credit = {
    ...note,
    commitment: context.outputCommitment,
    nullifier: await creditNullifier(context, note),
    draw: await deriveCreditState(context, note, 30n),
};
vectors.source =
    "Independent protocol Node ECDH/HKDF/AES-GCM and Poseidon2; public test keys only; mode-B Credit available balance with canonical unlimited flag and opaque payload.";
for (const entry of vectors.creditStateCases ?? []) {
    const fields = Object.fromEntries(
        Object.entries(entry.fields).map(([key, value]) => [
            key,
            typeof value === "boolean" ? value : BigInt(value),
        ])
    );
    entry.fields = fields;
    try {
        entry.expected = applyCreditDrawUsage(
            { ...note, ...fields },
            BigInt(entry.drawAmount),
            creditPeriods(BigInt(entry.timestamp))
        );
        entry.reject = false;
    } catch {
        delete entry.expected;
        entry.reject = true;
    }
}
for (const [role, code] of [
    ["owner", 1],
    ["spender", 2],
]) {
    const entropy = {
        ephemeralPrivateKey: "0x" + "09".repeat(32),
        salt: Buffer.alloc(16, 7),
        iv: Buffer.alloc(12, 8),
    };
    const envelope = await encryptCreditNote(
        vectors[role].viewingPublicKey,
        state,
        context,
        code,
        entropy
    );
    vectors.credit[role + "Ciphertext"] = "0x" + envelope.toString("hex");
}
vectors.credit.ownerReceivingKeys = state.ownerReceivingKeys;
vectors.credit.spenderReceivingKeys = state.spenderReceivingKeys;
vectors.credit.deliverySource = {
    envelopeType: 1,
    envelopeVersion: 2,
    header: 130,
    ciphertextBytes: (vectors.credit.ownerCiphertext.length - 2) / 2,
    protocolClientSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
    purpose:
        "Independent Node crypto delivery vectors; canonical fixture clue points do not claim FMD detectability.",
};
const fundsSource = join(protocol, "scripts/private-transfer-client.mjs");
const { encryptPrivateTransferNote } = await import(pathToFileURL(fundsSource).href);
const { noteCommitment, noteNullifier } = await import(
    pathToFileURL(join(protocol, "scripts/wallet-client.mjs")).href
);
const commitment = await noteCommitment(
    context.chainId,
    BigInt(context.protocolAddress),
    BigInt(vectors.note.ownerAddress),
    BigInt(context.tokenAddress),
    BigInt(vectors.note.amount),
    BigInt(vectors.note.nonce)
);
const hexField = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");
vectors.note.commitment = hexField(commitment);
vectors.note.nullifier = hexField(
    await noteNullifier(
        context.chainId,
        BigInt(context.protocolAddress),
        BigInt(vectors.note.nonce),
        commitment
    )
);
const fundsEnvelope = await encryptPrivateTransferNote(
    vectors.owner.viewingPublicKey,
    {
        ownerAddress: BigInt(vectors.note.ownerAddress),
        amount: BigInt(vectors.note.amount),
        nonce: BigInt(vectors.note.nonce),
    },
    { ...context, outputCommitment: vectors.note.commitment },
    {
        ephemeralPrivateKey: "0x" + "09".repeat(32),
        salt: Buffer.alloc(16, 7),
        iv: Buffer.alloc(12, 8),
    }
);
vectors.note.ciphertext = "0x" + fundsEnvelope.toString("hex");
vectors.note.deliverySource = {
    envelopeType: 0,
    envelopeVersion: 2,
    header: 1,
    ciphertextBytes: fundsEnvelope.length,
    protocolClientSha256: createHash("sha256").update(readFileSync(fundsSource)).digest("hex"),
};
for (const vector of vectors.memoVectors ?? []) {
    if (vector.kind !== "funds") {
        const envelope = await encryptCreditNote(
            vectors[vector.role].viewingPublicKey,
            {
                ...state,
                note: { ...state.note, memo: Buffer.from(vector.memo.slice(2), "hex") },
            },
            context,
            vector.role === "owner" ? 1 : 2,
            {
                ephemeralPrivateKey: "0x" + "09".repeat(32),
                salt: Buffer.alloc(16, 7),
                iv: Buffer.alloc(12, 8),
            }
        );
        vector.ciphertext = "0x" + envelope.toString("hex");
        continue;
    }
    const envelope = await encryptPrivateTransferNote(
        vectors.owner.viewingPublicKey,
        {
            ownerAddress: BigInt(vectors.note.ownerAddress),
            amount: BigInt(vectors.note.amount),
            nonce: BigInt(vectors.note.nonce),
            memo: Buffer.from(vector.memo.slice(2), "hex"),
        },
        { ...context, outputCommitment: vectors.note.commitment },
        {
            ephemeralPrivateKey: "0x" + "09".repeat(32),
            salt: Buffer.alloc(16, 7),
            iv: Buffer.alloc(12, 8),
        }
    );
    vector.ciphertext = "0x" + envelope.toString("hex");
}
writeFileSync(
    file,
    JSON.stringify(vectors, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n"
);
console.log("Refreshed funds and Credit payloadLength envelopes from the protocol implementation.");
