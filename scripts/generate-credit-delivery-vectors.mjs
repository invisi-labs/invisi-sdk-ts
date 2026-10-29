/** Refresh public-test Credit envelopes using the actual protocol Node implementation. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const sdk = resolve(import.meta.dirname, "..");
const protocol = resolve(process.argv[2] ?? join(sdk, "../invisi-protocol"));
const source = join(protocol, "scripts/create-credit-client.mjs");
const { encryptCreditNote } = await import(pathToFileURL(source).href);
const file = join(sdk, "packages/core/src/testdata/wallet-note-vectors.json");
const vectors = JSON.parse(readFileSync(file, "utf8"));
const clueKey = "0xc69480518ea88f8cb925fbcd8f5100b1ebc46cc4d8cbe19e0478936567e6b211";
const fields = [
    "spenderWalletIdentity",
    "ownerWalletIdentity",
    "spenderPayout",
    "ownerPayout",
    "amount",
    "nonce",
    "expiry",
    "creditSharedKey",
];
const note = Object.fromEntries(fields.map((field) => [field, BigInt(vectors.credit[field])]));
const state = {
    note,
    ownerReceivingKeys: { viewingPublicKey: vectors.owner.viewingPublicKey, clueKey },
    spenderReceivingKeys: { viewingPublicKey: vectors.spender.viewingPublicKey, clueKey },
};
const context = {
    ...vectors.context,
    chainId: BigInt(vectors.context.chainId),
    outputCommitment: vectors.credit.commitment,
};
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
    envelopeVersion: 4,
    ciphertextBytes: 402,
    protocolClientSha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
    purpose:
        "Independent Node crypto delivery vectors; canonical fixture clue points do not claim FMD detectability.",
};
writeFileSync(file, JSON.stringify(vectors, null, 2) + "\n");
console.log("Refreshed two 402-byte Credit envelopes from the protocol implementation.");
