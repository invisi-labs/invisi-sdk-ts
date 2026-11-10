import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet as EvmWallet, hexlify, sha256 } from "ethers";
import { expect, it, vi } from "vitest";
import {
    ProvenanceClient,
    RecognizedTree,
    PROVENANCE_MANIFEST_SHA256,
    authenticateManifest,
    recognizedLeaf,
    rootCertificateMessage,
    scopeHash,
    word,
    type RootCertificate,
    type OfflineProver,
    type TrustContext,
} from "@invisi-labs/core/provenance";
import { WalletSession, EncryptedWalletCodec } from "../../../session/src/index";
import { SQLiteWalletStore, type SQLiteConnection } from "../../../session/src/storage/sqlite";
import { scopeKey } from "../../../session/src/storage/store";
import { backend, setup } from "../transactions/execution/ExplicitTransaction-fixtures";
import { sessionOptions } from "../../../../test-support/session-options";
import { Provenance } from "./Provenance";

// Mock proof bytes test durable recovery and Source binding; this is not a native proof/chain E2E.
it("reopens encrypted original operations and proves only after payment and recognition data become available", async () => {
    const h = await setup();
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
        DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
    };
    const directory = await mkdtemp(join(tmpdir(), "invisi-source-recovery-"));
    const path = join(directory, "wallet.sqlite");
    const keyBytes = new Uint8Array(32).fill(9);
    let database = new DatabaseSync(path);
    let open = true;
    const main = backend();
    let sourceOnline = false,
        recognized = false;
    const requests: any[] = [];
    const sourceProve = vi.fn<
        Parameters<OfflineProver["prove"]>,
        ReturnType<OfflineProver["prove"]>
    >(async (request) => {
        expect((request.witness.nonces as bigint[])[0]).toBe(h.note.nonce);
        return { proof: "0x0102", publicInputs: [...request.expectedPublicInputs] };
    });
    try {
        let store = new SQLiteWalletStore(database, await EncryptedWalletCodec.fromBytes(keyBytes));
        const original = await h.store.readSnapshot(h.scope);
        await store.transaction(h.scope, (state) => {
            state.notes = original.notes;
            if (original.observedThrough) state.observedThrough = original.observedThrough;
        });
        let session = new WalletSession(sessionOptions({ ...h.options, store, prover: main }));
        const prepared = await session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [],
            withdrawal: { to: h.bob.ownerAddress, amount: 100n },
        });
        const signer = new EvmWallet("0x" + "01".repeat(32));
        const authorization = await prepared.exportWalletAuthorization();
        const signature = await signer.signTypedData(
            authorization.domain,
            authorization.types,
            authorization.message
        );
        const ready = await (await prepared.withWalletSignature(signature)).prove();
        const call = await ready.exportTransaction();
        const hash = word(900) as `0x${string}`;
        const send = vi.fn(async () => hash);
        await ready.trackTransaction(await send());
        const before = (await store.readSnapshot(h.scope)).operations[ready.id]!.payload as any;
        expect(before.provenance).toBeUndefined();
        expect(before.plan.inputs[0].note.nonce).toBe(h.note.nonce);
        expect(sourceProve).not.toHaveBeenCalled();
        expect(requests).toHaveLength(0);
        const row = database
            .prepare("SELECT data FROM invisi_wallet_state WHERE scope_key=?")
            .get(scopeKey(h.scope)) as { data: Uint8Array };
        expect(new TextDecoder().decode(row.data)).not.toContain('"nonce"');
        database.close();
        open = false;

        // A different store/codec/session instance has only the encrypted journal, never the old ready handle.
        database = new DatabaseSync(path);
        open = true;
        store = new SQLiteWalletStore(database, await EncryptedWalletCodec.fromBytes(keyBytes));
        session = new WalletSession(sessionOptions({ ...h.options, store, prover: main }));
        h.reader.getTransaction = async () => ({
            ...call,
            transactionHash: hash,
            from: signer.address as `0x${string}`,
            nonce: 0n,
        });
        h.reader.getReceipt = async () => ({
            block: await h.reader.getBlock(12n),
            transactionHash: hash,
            status: "success",
            logs: [],
        });
        h.reader.isSpent = async (_scope, words) => words.map(() => true);
        const restored = await session.resume(ready.id);
        const confirmed = await restored.reconcile();
        expect(confirmed.status).toBe("confirmed");
        await store.transaction(h.scope, (state) => {
            state.notes = {};
            state.reservations = {};
        });
        expect((await store.readSnapshot(h.scope)).operations[ready.id]!.payload).toMatchObject({
            call,
        });

        const signingKey = createPrivateKey({
            key: Buffer.from("302e020100300506032b657004220420" + "07".repeat(32), "hex"),
            format: "der",
            type: "pkcs8",
        });
        const publicKey = new Uint8Array(
            createPublicKey(signingKey).export({ format: "der", type: "spki" }).subarray(-32)
        );
        const tree = new RecognizedTree();
        await tree.appendCommitment(h.context, h.leaf);
        const certificate: RootCertificate = {
            certificateVersion: "1",
            providerId: word(19),
            signingKeyId: sha256(publicKey),
            chainId: h.context.chainId,
            protocolAddress: h.context.protocolAddress,
            chainGeneration: "1",
            rootSequence: "1",
            treeId: "1",
            leafCount: "1",
            root: await tree.root(),
            confirmedBlockNumber: "12",
            confirmedBlockHash: word(12),
            decisionLogHash: word(0),
            previousCheckpointHash: word(0),
            issuedAt: String(Math.floor(Date.now() / 1000)),
            signature: "0x",
        };
        certificate.signature = hexlify(
            sign(null, rootCertificateMessage(certificate), signingKey)
        );
        const manifest = authenticateManifest(
            await readFile(new URL("../../../prover/provenance/manifest.json", import.meta.url)),
            PROVENANCE_MANIFEST_SHA256
        );
        const trust: TrustContext = {
            ...h.context,
            chainGeneration: "1",
            providerId: certificate.providerId,
            manifestSha256: manifest.sha256,
            signingKeys: { [String(certificate.signingKeyId)]: publicKey },
        };
        const client = new ProvenanceClient("https://source.test", trust, async (_url, init) => {
            const request = JSON.parse(String(init?.body));
            requests.push(request);
            if (!sourceOnline) throw Error("Source offline");
            let result: Record<string, unknown>;
            if (request.method === "provenance_getStatus")
                result = { checkpointSequence: recognized ? "1" : "0", activeTreeId: "1" };
            else if (request.method === "provenance_getRoot")
                result = {
                    rootId: request.params[0].rootId,
                    certificate,
                    allowedForNewProof: recognized,
                };
            else if (request.method === "provenance_getLeaves")
                result = {
                    rootId: "1:1",
                    certificate,
                    nextIndex: "1",
                    items: [
                        {
                            scope: {
                                chainId: String(h.context.chainId),
                                protocolAddress: h.context.protocolAddress,
                            },
                            noteCommitment: h.leaf,
                            leaf: await recognizedLeaf(await scopeHash(h.context), h.leaf),
                            treeId: "1",
                            chainGeneration: "1",
                            leafIndex: "0",
                            checkpointSequence: "1",
                        },
                    ],
                };
            else if (request.method === "provenance_submitSourceProof") {
                const pi = request.params[0].proofSidecars[0].proofBundle.publicInputs;
                result = {
                    broadcastDecision: "allow",
                    tracking: {
                        id: "a".repeat(48),
                        status: "pending_source",
                        operationDigest: word((BigInt(pi[7]) << 128n) | BigInt(pi[8])),
                    },
                };
            } else throw Error(request.method);
            return new Response(
                JSON.stringify(
                    {
                        jsonrpc: "2.0",
                        id: request.id,
                        result: {
                            scope: {
                                chainId: String(h.context.chainId),
                                protocolAddress: h.context.protocolAddress,
                            },
                            chainGeneration: "1",
                            providerId: trust.providerId,
                            signingKeyId: certificate.signingKeyId,
                            manifestSha256: manifest.sha256,
                            ...result,
                        },
                    },
                    (_, v) => (typeof v === "bigint" ? v.toString() : v)
                )
            );
        });
        const provenance = new Provenance({
            prover: {
                getProvenanceClient: async () => client,
                getProvenanceCapability: async () => ({
                    client,
                    manifest,
                    prover: { prove: sourceProve },
                }),
            },
        });
        await expect(provenance.prove(confirmed)).rejects.toThrow(/offline/);
        sourceOnline = true;
        await expect(provenance.prove(confirmed)).rejects.toThrow(/recognized root/);
        expect(sourceProve).not.toHaveBeenCalled();
        expect(
            ((await store.readSnapshot(h.scope)).operations[ready.id]!.payload as any).provenance
        ).toBeUndefined();
        recognized = true;
        const packet = await provenance.prove(confirmed);
        expect(packet.data).toBe(call.data);
        expect(sourceProve).toHaveBeenCalledTimes(1);
        expect(main.prove).toHaveBeenCalledTimes(1);
        expect(send).toHaveBeenCalledTimes(1);
        expect((await provenance.submit(packet)).broadcastDecision).toBe("allow");
        expect(JSON.stringify(requests)).not.toMatch(/"(nonce|nonces|opening|witness|paths)"/);
        expect((await store.readSnapshot(h.scope)).operations[ready.id]!.status).toBe("confirmed");
    } finally {
        if (open) database.close();
        keyBytes.fill(0);
        await rm(directory, { recursive: true, force: true });
    }
});
