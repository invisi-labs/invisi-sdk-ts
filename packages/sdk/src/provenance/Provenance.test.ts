import { bindBroadcasterOperation } from "../broadcaster/operation-bridge";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { hexlify, sha256 } from "ethers";
import { Wallet } from "@invisi-labs/core";
import {
    authenticateManifest,
    bindingDigest,
    inputDigest,
    operationDigest,
    rootCertificateMessage,
    scopeHash,
    sourcesDigest,
    word,
    type RootCertificate,
    type TrustContext,
} from "@invisi-labs/core/provenance";
import { transactUserPublicInputs } from "@invisi-labs/protocol";
import { decodeBroadcasterIntent } from "../broadcaster/index";
import { setup, externallyAuthorize } from "../transactions/execution/ExplicitTransaction-fixtures";
import { testOutput } from "../../../../test-support/test-output";
import { Provenance } from "./Provenance";
import type { ProvenanceProof } from "./proof-record";

// Mock proof bytes exercise packet and transport boundaries, not Noir/BB verification.
async function fixture() {
    const h = await setup();
    const ready = await (
        await externallyAuthorize(
            await h.invisi.prepareTransfer({
                wallet: Wallet.fromAddress(h.wallet.getAddress()),
                protocol: h.protocol,
                tokenAddress: h.context.tokenAddress,
                inputs: h.inputs,
                outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
            })
        )
    ).prove();
    const call = await ready.exportTransaction();
    const decoded = decodeBroadcasterIntent(call.data);
    const raw = decoded.request.params;
    const params = {
        token: raw.token,
        sources: Array.from(raw.sources, (s: any) => ({
            treeId: s.treeId,
            merkleRoot: s.merkleRoot,
        })),
        nullifiers: [...raw.nullifiers],
        noteCommitments: [...raw.noteCommitments],
        withdrawalAddress: raw.withdrawalAddress,
        withdrawalAmount: raw.withdrawalAmount,
        deadline: raw.deadline,
        feeRecipient: raw.feeRecipient,
        feeAmount: raw.feeAmount,
    };
    const funding = decoded.request.funding.toObject(true);
    funding.permit.v = Number(funding.permit.v);
    const deliveries = decoded.request.deliveries.map((d: any) => d.toObject(true));
    const publicInputs = transactUserPublicInputs(h.context, params, deliveries, funding);
    const capacity = (publicInputs.length - 17) / 3;
    const digest = operationDigest({ ...h.context, mainCircuitCapacity: capacity, publicInputs });
    const manifest = authenticateManifest(
        readFileSync(new URL("../../../prover/provenance/manifest.json", import.meta.url)),
        "cf07e868bd354382f2137f789e6b049563289b779e061728050936d23076f31a"
    );
    const key = createPrivateKey({
        key: Buffer.from("302e020100300506032b657004220420" + "07".repeat(32), "hex"),
        format: "der",
        type: "pkcs8",
    });
    const pub = new Uint8Array(
        createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32)
    );
    const cert: RootCertificate = {
        certificateVersion: "1",
        providerId: word(19),
        signingKeyId: sha256(pub),
        chainId: String(h.context.chainId),
        protocolAddress: h.context.protocolAddress,
        chainGeneration: "1",
        rootSequence: "1",
        treeId: "1",
        leafCount: "1",
        root: word(123),
        confirmedBlockNumber: "12",
        confirmedBlockHash: word(12),
        decisionLogHash: word(0),
        previousCheckpointHash: word(0),
        issuedAt: String(Math.floor(Date.now() / 1000)),
        signature: "0x",
    };
    cert.signature = hexlify(sign(null, rootCertificateMessage(cert), key));
    const trust: TrustContext = {
        ...h.context,
        chainGeneration: "1",
        providerId: cert.providerId,
        signingKeys: { [String(cert.signingKeyId)]: pub },
        manifestSha256: manifest.sha256,
    };
    const sd = await sourcesDigest("1", [cert]);
    const id = await inputDigest(params.nullifiers);
    const binding = await bindingDigest({
        scope: await scopeHash(trust),
        tokenAddress: h.context.tokenAddress,
        chainGeneration: "1",
        sourceCount: 1,
        sourcesDigest: sd,
        inputCount: 1,
        operationDigest: digest,
        inputDigest: id,
    });
    const packet: ProvenanceProof = {
        format: "invisi-provenance-submission-v1",
        data: call.data,
        context: { ...h.context, chainId: String(h.context.chainId) },
        mainCircuitCapacity: capacity,
        publicInputs,
        operationDigest: digest,
        sidecars: [
            {
                operationIndex: "0",
                proofBundle: {
                    format: "invisi-provenance-proof-v1",
                    circuitId: "provenance_k1",
                    manifestSha256: manifest.sha256,
                    target: "evm",
                    proof: "0x0102",
                    rootCertificates: [cert],
                    publicInputs: [
                        h.context.chainId,
                        h.context.protocolAddress,
                        h.context.tokenAddress,
                        1,
                        1,
                        sd,
                        1,
                        BigInt(digest) >> 128n,
                        BigInt(digest) & ((1n << 128n) - 1n),
                        id,
                        binding,
                    ].map(word),
                },
            },
        ],
    };
    const client = {
        trust,
        evaluateTransaction: vi.fn(async () => ({ accepted: true })),
        submitProof: vi.fn(async () => ({ jobId: "job" })),
    };
    const block = await h.reader.getBlock(12n);
    const hash = word(500);
    const reader = {
        ...h.reader,
        getTransaction: vi.fn(async () => ({ ...call, transactionHash: hash })),
        getReceipt: vi.fn(async () => ({
            transactionHash: hash,
            block,
            status: "success",
            logs: [],
        })),
    };
    const options = {
        client: client as any,
        prover: { prove: vi.fn() },
        manifest,
        chainReader: reader as any,
    };
    return { packet, client, options, hash, reader };
}

it("resubmits a JSON-only public packet before and after canonical main without reproof", async () => {
    const h = await fixture();
    const saved = JSON.stringify(h.packet);
    expect(saved).not.toMatch(/witness|opening|nonce|client|prover/);
    await new Provenance({ client: h.options.client }).submit(JSON.parse(saved));
    expect(h.client.evaluateTransaction).toHaveBeenCalledWith(h.packet.data, h.packet.sidecars);
    await new Provenance({ client: h.options.client, chainReader: h.reader as any }).submit(
        JSON.parse(saved),
        { transactionHash: h.hash }
    );
    await new Provenance({ client: h.options.client, chainReader: h.reader as any }).submit(
        JSON.parse(saved),
        { transactionHash: h.hash }
    );
    expect(h.client.submitProof.mock.calls[0]).toEqual(h.client.submitProof.mock.calls[1]);
    expect(h.options.prover.prove).not.toHaveBeenCalled();
});

it("rejects mutated native statements, proof bindings, scope and private fields before HTTP", async () => {
    const h = await fixture();
    for (const mutate of [
        (p: ProvenanceProof) => {
            p.publicInputs[0] = word(7);
        },
        (p: ProvenanceProof) => {
            p.operationDigest = word(7);
        },
        (p: ProvenanceProof) => {
            p.sidecars[0]!.proofBundle.publicInputs[9] = word(7);
        },
        (p: ProvenanceProof) => {
            p.context.chainId = "7";
        },
        (p: ProvenanceProof) => {
            p.sidecars[0]!.proofBundle.publicInputs[3] = word(2);
        },
        (p: ProvenanceProof) => {
            p.sidecars[0]!.proofBundle.rootCertificates[0]!.root = word(7);
        },
        (p: ProvenanceProof) => {
            Object.assign(p.sidecars[0]!, { witness: "private" });
        },
        (p: ProvenanceProof) => {
            Object.assign(p, { opening: "private" });
        },
        (p: ProvenanceProof) => {
            p.mainCircuitCapacity++;
        },
        (p: ProvenanceProof) => {
            p.data += "00";
        },
    ]) {
        const packet = structuredClone(h.packet);
        mutate(packet);
        await expect(new Provenance(h.options).submit(packet)).rejects.toThrow();
    }
    expect(h.client.evaluateTransaction).not.toHaveBeenCalled();
    expect(h.client.submitProof).not.toHaveBeenCalled();
});

it("requires a canonical successful transaction with exact calldata and an explicit reader", async () => {
    const h = await fixture();
    await expect(
        new Provenance({ client: h.options.client }).submit(h.packet, { transactionHash: h.hash })
    ).rejects.toThrow(/ChainReader/);
    h.reader.getReceipt.mockResolvedValueOnce({
        transactionHash: h.hash,
        block: { ...(await h.options.chainReader.getBlock(12n)), hash: word(99) },
        status: "success",
        logs: [],
    });
    await expect(
        new Provenance(h.options).submit(h.packet, { transactionHash: h.hash })
    ).rejects.toThrow(/canonical/);
    h.reader.getTransaction.mockResolvedValueOnce({
        to: h.packet.context.protocolAddress as `0x${string}`,
        data: "0x00",
        value: 0n,
        transactionHash: h.hash,
    });
    await expect(
        new Provenance(h.options).submit(h.packet, { transactionHash: h.hash })
    ).rejects.toThrow(/transaction mismatch/);
    expect(h.client.submitProof).not.toHaveBeenCalled();
});

it("requires local proving capability only for proof generation", async () => {
    const h = await fixture();
    const ready = { id: "ready", status: "ready" };
    bindBroadcasterOperation(ready, {
        readProvenance: async () => undefined,
        quote: async () => ready,
        submit: async () => ({ id: "service-id", state: "pending" }),
        proveProvenance: async () => {
            throw Error("unexpected proving");
        },
    });
    await expect(new Provenance({ client: h.options.client }).prove(ready)).rejects.toThrow(
        /manifest and prover/
    );
    expect(h.client.evaluateTransaction).not.toHaveBeenCalled();
});
