import { readFileSync } from "node:fs";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
    PROVENANCE_MANIFEST_SHA256,
    RecognizedTree,
    noteOpening,
    rootCertificateMessage,
    word,
    type RootCertificate,
} from "@invisi-labs/protocol/provenance";
import { authenticateManifest, type OfflineProver } from "@invisi-labs/prover/provenance-witness";
import { prepareProvenance } from "./provenance-preparation";
import type { OperationPlan, TransactionRuntime } from "../transactions/operation-types";

// Source selection consumes an authenticated main statement independently of its slot capacity.
vi.mock("../transactions/signing/statement", () => ({
    statement: (plan: OperationPlan) => ({
        expectedPublicInputs: Array(17 + 3 * plan.capacity!).fill(word(0)),
    }),
}));

it.each([
    { inputCount: 1, outputCount: 0, expectedCapacity: 10 },
    { inputCount: 15, outputCount: 0, expectedCapacity: 20 },
    { inputCount: 5, outputCount: 10, expectedCapacity: 10 },
])(
    "selects K$expectedCapacity for C190 with $inputCount private inputs and $outputCount outputs",
    async ({ inputCount, outputCount, expectedCapacity }) => {
        const context = { chainId: 31337n, protocolAddress: word(1), tokenAddress: word(2) };
        const tree = new RecognizedTree();
        const inputs = await Promise.all(
            Array.from({ length: inputCount }, async (_, i) => {
                const note = { ownerAddress: word(3), nonce: BigInt(i + 1), amount: 1n };
                const opening = await noteOpening({
                    ...context,
                    owner: note.ownerAddress,
                    ...note,
                });
                return { note, commitment: opening.commitment, nullifier: opening.nullifier };
            })
        );
        for (const input of inputs) await tree.appendCommitment(context, input.commitment);
        const key = createPrivateKey({
            key: Buffer.from("302e020100300506032b657004220420" + "07".repeat(32), "hex"),
            format: "der",
            type: "pkcs8",
        });
        const publicKey = new Uint8Array(
            createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)
        );
        const certificate: RootCertificate = {
            certificateVersion: 1,
            providerId: 1,
            signingKeyId: 2,
            chainId: context.chainId,
            protocolAddress: context.protocolAddress,
            chainGeneration: 1,
            rootSequence: 1,
            treeId: 1,
            leafCount: inputCount,
            root: await tree.root(),
            confirmedBlockNumber: 12,
            confirmedBlockHash: 12,
            decisionLogHash: 0,
            previousCheckpointHash: 0,
            issuedAt: 1,
            signature: "0x",
        };
        certificate.signature =
            "0x" +
            Buffer.from(sign(null, rootCertificateMessage(certificate), key)).toString("hex");
        const manifest = authenticateManifest(
            readFileSync(new URL("../../../prover/provenance/manifest.json", import.meta.url)),
            PROVENANCE_MANIFEST_SHA256
        );
        const prover = {
            prove: vi.fn(async (request: Parameters<OfflineProver["prove"]>[0]) => ({
                proof: "0x01",
                publicInputs: [...request.expectedPublicInputs],
            })),
        };
        const client = {
            trust: {
                ...context,
                chainGeneration: 1,
                providerId: 1,
                signingKeys: { [word(2)]: publicKey },
                manifestSha256: manifest.sha256,
            },
            getStatus: async () => ({ checkpointSequence: 1 }),
            getRoot: async () => ({ certificate, allowedForNewProof: true }),
            syncRecognizedTree: async () => tree,
        };
        const plan = {
            context,
            capacity: 190,
            inputs,
            outputs: Array.from({ length: outputCount }, () => ({})),
            params: { nullifiers: inputs.map((input) => input.nullifier) },
        } as unknown as OperationPlan;
        const runtime = {
            options: { provenance: { client, manifest, prover } },
            reader: {
                getChainId: async () => context.chainId,
                getBlock: async () => ({ hash: word(12) }),
            },
        } as unknown as TransactionRuntime;
        const result = await prepareProvenance(plan, runtime);
        expect(prover.prove).toHaveBeenCalledWith(
            expect.objectContaining({ capacity: expectedCapacity })
        );
        expect(result.sidecars[0]!.proofBundle.circuitId).toBe(`provenance_k${expectedCapacity}`);
        expect(result.sidecars[0]!.proofBundle.publicInputs[6]).toBe(word(inputCount));
        expect(plan.capacity).toBe(190);
    }
);
