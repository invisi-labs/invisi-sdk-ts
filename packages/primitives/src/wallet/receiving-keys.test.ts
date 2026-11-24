import { inspect } from "node:util";
import { getAddress, getBytes, hashMessage, hexlify, Wallet as EthersWallet } from "ethers";
import { secp256k1 } from "@noble/curves/secp256k1";
import { describe, expect, it } from "vitest";
import {
    buildReceivingKeyMessage,
    computeNoteCommitment,
    computeNoteIdentity,
    createClueFromSeed,
    decryptPrivateTransferNote,
    deriveReceivingKeysFromSignature,
    encryptPrivateTransferNote,
    verifyWalletAuthorization,
    type Note,
} from "../index";
import { detectClue } from "../fmd/fmd";
import { deriveWallet, signWalletAuthorization } from "./wallet";
import {
    deriveReceivingRoot,
    normalizeReceivingSignature,
    receivingKeyDigest,
    signReceivingKeyMessage,
} from "./receiving-key-derivation";
import fixture from "./testdata/receiving-signature-v1-vectors.json";

const [first, other] = fixture.vectors;
const derive = (signature: string | Uint8Array, ownerAddress = first!.ownerAddress) =>
    deriveReceivingKeysFromSignature({ ownerAddress, signature });

describe("receiving signature v1", () => {
    it.each(fixture.vectors)(
        "matches canonical bytes and all public receiving material for $ownerAddress",
        async (row) => {
            const privateKey = getBytes(row.privateKey);
            const local = new EthersWallet(row.privateKey);
            for (const owner of [
                row.ownerAddress,
                getAddress(row.ownerAddress),
                "0x" + row.ownerAddress.slice(2).toUpperCase(),
            ]) {
                const message = buildReceivingKeyMessage(owner);
                expect(new TextDecoder().decode(message)).toBe(row.message);
                expect(hexlify(message)).toBe(row.messageHex);
                expect(hashMessage(message)).toBe(row.digest);
            }
            expect(await local.signMessage(buildReceivingKeyMessage(local.address))).toBe(
                row.signature
            );
            const ownerAddress = row.ownerAddress as `0x${string}`;
            const digest = receivingKeyDigest(ownerAddress);
            expect(hexlify(digest)).toBe(row.digest);
            expect(hexlify(signReceivingKeyMessage(ownerAddress, privateKey))).toBe(
                row.signatureV0
            );

            for (const signature of [
                row.signature,
                row.signatureV0,
                row.signatureHighS,
                row.signatureCompact,
                getBytes(row.signature),
            ]) {
                const material = normalizeReceivingSignature(ownerAddress, digest, signature);
                expect(hexlify(material)).toBe(row.receivingKeyMaterial);
                expect(hexlify(deriveReceivingRoot(ownerAddress, material))).toBe(
                    row.invisiRootKey
                );
                const keys = derive(signature, row.ownerAddress);
                expect(keys.ownerAddress).toBe(row.ownerAddress);
                expect(hexlify(keys.getViewer().exportKey())).toBe(row.viewingPrivateKey);
                expect(hexlify(keys.viewingPublicKey)).toBe(row.viewingPublicKey);
                expect(hexlify(keys.getDetector().exportKey())).toBe(row.detectionKey);
                expect(hexlify(keys.clueKey)).toBe(row.clueKey);
                expect(keys.getAddress()).toBe(row.receivingAddress);
            }
            const localWallet = await deriveWallet(privateKey);
            expect(hexlify(privateKey)).toBe(row.privateKey);
            expect(hexlify(localWallet.spendingPrivateKey)).toBe(row.privateKey);
            expect(hexlify(localWallet.spendingPublicKey)).toBe(row.spendingPublicKey);
            expect(localWallet.ownerAddress).toBe(row.ownerAddress);
            expect(hexlify(localWallet.viewingPrivateKey)).toBe(row.viewingPrivateKey);
            expect(hexlify(localWallet.detectionSeed)).toBe(row.detectionSeed);
            expect(hexlify(localWallet.detectionKey)).toBe(row.detectionKey);
        }
    );

    it("redacts receiving secrets in default representations and provides isolated key exports", () => {
        const signature = getBytes(first!.signature);
        const keys = derive(signature);
        expect(hexlify(signature)).toBe(first!.signature);
        expect({ ...keys }).toEqual({});
        expect(JSON.parse(JSON.stringify(keys))).toEqual({
            ownerAddress: first!.ownerAddress,
            address: first!.receivingAddress,
        });
        for (const secret of [
            first!.viewingPrivateKey,
            first!.detectionKey,
            first!.signature,
            first!.invisiRootKey,
        ]) {
            expect(inspect(keys, { showHidden: true })).not.toContain(secret.slice(2));
        }
        const viewing = keys.getViewer().exportKey();
        const detection = keys.getDetector().exportKey();
        viewing.fill(0);
        detection.fill(0);
        expect(hexlify(keys.getViewer().exportKey())).toBe(first!.viewingPrivateKey);
        expect(hexlify(keys.getDetector().exportKey())).toBe(first!.detectionKey);
        expect(keys).not.toHaveProperty("spendingPrivateKey");
        expect(keys).not.toHaveProperty("exportAuthorization");
    });

    it("rejects invalid owners and invalid or unrelated signatures", async () => {
        for (const owner of [
            "0x" + "00".repeat(20),
            "0x1234",
            first!.receivingAddress,
            "0x7E5f4552091a69125d5dfcb7b8c2659029395bdf",
        ]) {
            expect(() => buildReceivingKeyMessage(owner)).toThrow();
            expect(() => derive(first!.signature, owner)).toThrow();
        }
        expect(() => derive(first!.signature, other!.ownerAddress)).toThrow(/owner/);
        const software = new EthersWallet(first!.privateKey);
        const wrongMessage = await software.signMessage(first!.message + "\n");
        const hexText = await software.signMessage(first!.messageHex);
        const prefixedMessage = new Uint8Array([
            ...new TextEncoder().encode(`\x19Ethereum Signed Message:\n${first!.message.length}`),
            ...getBytes(first!.messageHex),
        ]);
        const doublePrefix = await software.signMessage(prefixedMessage);
        const r = first!.signature.slice(2, 66);
        const s = first!.signature.slice(66, 130);
        const zero = "00".repeat(32);
        const order = secp256k1.CURVE.n.toString(16);
        const wrongHighSParity = first!.signatureHighS.slice(0, -2) + "1b";
        for (const signature of [
            wrongMessage,
            hexText,
            doublePrefix,
            "0x",
            "0xxyz",
            first!.signature.slice(0, -4),
            `0x${r}${s}02`,
            `0x${r}${s}25`,
            `0x${zero}${s}1b`,
            `0x${r}${zero}1b`,
            `0x${order}${s}1b`,
            `0x${r}${order}1b`,
            wrongHighSParity,
        ]) {
            expect(() => derive(signature)).toThrow();
        }
    });

    it("detects and decrypts funds addressed using the receiving signature and authorizes spending with the original EVM key", async () => {
        const keys = derive(first!.signature);
        const recipient = keys.getReceivingAddress();
        const note: Note = {
            chainId: 31337n,
            protocolAddress: 0x1234n,
            tokenAddress: 0x4567n,
            ownerAddress: recipient.ownerAddress,
            amount: 500n,
            nonce: 41n,
            payload: Uint8Array.of(5, 9),
        };
        const context = {
            chainId: note.chainId,
            protocolAddress: note.protocolAddress,
            tokenAddress: note.tokenAddress,
            outputCommitment: await computeNoteCommitment(
                note.chainId,
                note.protocolAddress,
                await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
                note.tokenAddress,
                note.amount
            ),
        };
        const envelope = await encryptPrivateTransferNote(
            recipient.viewingPublicKey,
            note,
            context
        );
        const clue = createClueFromSeed(recipient.clueKey, new Uint8Array(32).fill(9));
        expect(keys.getDetector().detectClue(clue)).toBe(true);
        expect(() => keys.getDetector().detectClue(new Uint8Array(0))).toThrow(/Clue/);
        const otherClue = createClueFromSeed(
            derive(other!.signature, other!.ownerAddress).clueKey,
            new Uint8Array(32).fill(10)
        );
        expect(keys.getDetector().detectClue(otherClue)).toBe(false);
        expect(detectClue(keys.getDetector().exportKey(), clue)).toBe(true);
        const local = await deriveWallet(first!.privateKey);
        expect(detectClue(local.detectionKey, clue)).toBe(true);
        expect(await keys.getViewer().decryptNote(envelope, context)).toEqual(note);
        expect(
            await decryptPrivateTransferNote(local.viewingPrivateKey, envelope, {
                ...context,
                ownerAddress: local.ownerAddress,
            })
        ).toEqual(note);

        const request = {
            context,
            operation: "transact" as const,
            capacity: 1,
            words: [context.chainId, context.protocolAddress, BigInt(context.outputCommitment)],
        };
        const signature = signWalletAuthorization(local.spendingPrivateKey, request);
        expect(
            await verifyWalletAuthorization(
                note.ownerAddress,
                local.spendingPublicKey,
                signature,
                request
            )
        ).toBe(true);
        for (const receivingSignature of [
            signWalletAuthorization(keys.getViewer().exportKey(), request),
            first!.receivingKeyMaterial as `0x${string}`,
        ]) {
            expect(
                await verifyWalletAuthorization(
                    note.ownerAddress,
                    getBytes(first!.spendingPublicKey),
                    receivingSignature,
                    request
                )
            ).toBe(false);
        }
    });
});
