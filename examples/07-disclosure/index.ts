import { Disclosure, decodeMemoText, Wallet, type CreditNote, type Note } from "@invisi-labs/sdk";
import { encryptPrivateTransferNote, generateCreditSharedKey, generateNonce } from "@invisi-labs/core";

/** Offline illustration only. These public demo keys and numeric contexts are not a deployment. */
export async function main() {
    console.log("1. Restore two demonstration wallets locally");
    const alice = await Wallet.fromPrivateKey(`0x${"01".padStart(64, "0")}`);
    const bob = await Wallet.fromPrivateKey(`0x${"02".padStart(64, "0")}`);
    const offlineContext = { chainId: 31337n, protocolAddress: 1n, tokenAddress: 2n };
    const note: Note = {
        ...offlineContext,
        walletIdentity: bob.walletIdentity,
        amount: 30n,
        nonce: generateNonce(),
        memo: "Invoice INV-1042",
    };

    console.log("2. Create a commitment opening and explicitly export its sensitive contents");
    const opening = await Disclosure.fromNote(note);
    const openingMaterial = opening.export();
    const output = { ...offlineContext, outputCommitment: openingMaterial.context.outputCommitment, role: "funds" as const };

    // A commitment opening excludes the memo; the memo is authenticated by the encrypted delivery.
    // A complete funds opening permits consumption tracking and owner-only full sweep.
    // This checks the opening only. No RPC or canonical inclusion is claimed in this offline example.
    // verify-on-chain.ts independently resolves the transaction, insertion and delivery from a trusted RPC.
    const importedOpening = await Disclosure.fromExport(JSON.parse(JSON.stringify(openingMaterial)));
    const opened = await importedOpening.verify(output);
    console.log("Opening verified; disclosed amount:", opened.note.amount);

    console.log("3. Encrypt a demonstration output using the existing event-delivery envelope");
    const ciphertext = await encryptPrivateTransferNote(bob.viewingPublicKey, note, output);

    console.log("4. Bob discloses this output without exporting his wallet viewing private key");
    const keyed = await bob.getViewer().discloseNote(ciphertext, output);
    console.log("Review disclosure scope:", keyed.getScope());
    const sensitiveMaterial = keyed.export();

    // The application chooses the recipient and transport for this sensitive material. Never log it.
    // Do not replace this call with bob.getViewer().exportKey(), which delegates wallet-wide viewing.
    console.log("5. A third party imports the scoped key, decrypts and recomputes the commitment");
    const importedKey = await Disclosure.fromExport(JSON.parse(JSON.stringify(sensitiveMaterial)));
    const decrypted = await importedKey.verify({ ...output, ciphertext });
    console.log("Payload verified; disclosed amount:", decrypted.note.amount);
    // Decryption returns raw bytes. Decode explicitly only when your application expects UTF-8 text.
    if (decrypted.note.memo instanceof Uint8Array) console.log("Disclosed memo:", decodeMemoText(decrypted.note.memo));

    console.log("6. Disclose a Credit opening while retaining the shared recovery key");
    const credit: CreditNote = {
        ...offlineContext,
        spenderWalletIdentity: bob.walletIdentity,
        ownerWalletIdentity: alice.walletIdentity,
        spenderPayout: BigInt(bob.walletIdentity),
        ownerPayout: BigInt(alice.walletIdentity),
        amount: 100n,
        nonce: generateNonce(),
        expiry: 2_000_000_000n,
        creditSharedKey: generateCreditSharedKey(),
    };
    const creditOpening = await Disclosure.fromCredit(credit);
    console.log("Credit opening scope:", creditOpening.getScope());

    // Credit openings contain creditSharedKeyHash, not creditSharedKey or receiving-key snapshots.
    // viewer.discloseCredit(...) instead unlocks the entire selected Credit envelope, including those fields.
    // Neither disclosure proves payer identity, source of funds, spent state or complete wallet activity.
    console.log("7. Default object inspection is redacted; only export() releases disclosure material");
    console.log("Redacted disclosure:", keyed);
}
