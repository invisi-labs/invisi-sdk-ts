import { describe, it, expect } from "vitest";
import { getBytes } from "ethers";
import vectors from "./golden-vectors.json";
import {
    scopeHash,
    noteOpening,
    recognizedLeaf,
    buildWitness,
    RecognizedTree,
    operationDigest,
    rootCertificatePayload,
    rootCertificateMessage,
    checkpointHash,
    verifyRootCertificate,
    field,
    uint,
    ProvenanceClient,
    word,
    DOMAINS,
    PUBLIC_INPUTS,
} from "./index";
import type { RootCertificate, WitnessRequest, TrustContext } from "./index";
function request(w: typeof vectors.witnessK1 | typeof vectors.witnessK10CrossTree): WitnessRequest {
    const count = Number(w.input_count),
        sources = Number(w.source_count);
    return {
        capacity: w.owners.length,
        chainId: w.chain_id,
        protocolAddress: w.protocol_address,
        tokenAddress: w.token_address,
        chainGeneration: w.chain_generation,
        operationDigest: w.operation_digest_lo,
        inputs: w.owners.slice(0, count).map((owner, i) => ({
            owner,
            nonce: w.nonces[i]!,
            amount: w.amounts[i]!,
            sourceIndex: Number(w.source_indices[i]),
            leafIndex: w.leaf_indices[i]!,
            path: w.paths[i]!,
        })),
        sources: w.tree_ids
            .slice(0, sources)
            .map((treeId, i) => ({ treeId, root: w.roots[i]!, leafCount: w.leaf_counts[i]! })),
    };
}
describe("independent provenance family", () => {
    it("matches shared domains,scope,opening,leaf and EVM operation vectors", async () => {
        for (const [k, v] of Object.entries(vectors.domains))
            expect(DOMAINS[k as keyof typeof DOMAINS].toString()).toBe(v);
        const c = vectors.note.context;
        expect((await scopeHash(c)).toString()).toBe(vectors.note.scope);
        const o = await noteOpening(c);
        expect(o.commitment.toString()).toBe(vectors.note.commitment);
        expect(o.nullifier.toString()).toBe(vectors.note.nullifier);
        expect((await recognizedLeaf(vectors.note.scope, o.commitment)).toString()).toBe(
            vectors.note.recognizedLeaf
        );
        expect(operationDigest(vectors.operation)).toBe(vectors.operation.digest);
    });
    it.each([vectors.witnessK1, vectors.witnessK10CrossTree])(
        "matches complete padded local witness",
        async (v) => {
            const w = await buildWitness(request(v));
            for (const k of PUBLIC_INPUTS) expect(String(w[k])).toBe(v[k]);
            for (const k of [
                "owners",
                "nonces",
                "amounts",
                "source_indices",
                "leaf_indices",
                "tree_ids",
                "roots",
                "leaf_counts",
            ])
                expect((w[k] as bigint[]).map(String)).toEqual(
                    (v[k as keyof typeof v] as (string | number)[]).map(String)
                );
        }
    );
    it("rebuilds depth32 membership locally and rejects corrupted paths,duplicates and padding shape", async () => {
        const t = new RecognizedTree();
        t.append(vectors.note.recognizedLeaf);
        const p = await t.path(0);
        expect(p.root.toString()).toBe(vectors.witnessK1.roots[0]);
        expect(p.path.map(String)).toEqual(vectors.witnessK1.paths[0]);
        expect(
            (await t.membershipForCommitment(vectors.note.context, vectors.note.commitment))
                ?.leafIndex
        ).toBe(0);
        expect(await t.membershipForCommitment(vectors.note.context, "1")).toBeUndefined();
        const r = request(vectors.witnessK1);
        r.inputs[0]!.path = [...r.inputs[0]!.path];
        (r.inputs[0]!.path as string[])[0] = "1";
        await expect(buildWitness(r)).rejects.toThrow("Membership");
        await expect(
            buildWitness({ ...request(vectors.witnessK1), capacity: 11 })
        ).rejects.toThrow();
        const duplicate = request(vectors.witnessK1);
        await expect(
            buildWitness({
                ...duplicate,
                capacity: 2,
                inputs: [...duplicate.inputs, ...duplicate.inputs],
            })
        ).rejects.toThrow("Duplicate");
    });
    it("matches269-byte certificate,raw64 signature and rejects mutation", () => {
        const c = {
            ...Object.fromEntries(
                Object.entries(vectors.certificate.fields).map(([k, v]) => [k, String(v)])
            ),
            signature: "0x" + vectors.certificate.signatureHex,
        } as RootCertificate;
        expect(rootCertificatePayload(c).length).toBe(269);
        expect(rootCertificatePayload({ ...c, leafCount: "0" }).length).toBe(269);
        expect(Buffer.from(rootCertificatePayload(c)).toString("hex")).toBe(
            vectors.certificate.payloadHex
        );
        expect(Buffer.from(rootCertificateMessage(c)).toString("hex")).toBe(
            vectors.certificate.messageHex
        );
        expect(checkpointHash(c)).toBe(vectors.certificate.checkpointHash);
        const key = getBytes("0x" + vectors.certificate.publicKeySpkiHex).slice(-32);
        expect(verifyRootCertificate(c, key)).toBe(true);
        expect(verifyRootCertificate({ ...c, root: "11" }, key)).toBe(false);
        expect(verifyRootCertificate({ ...c, signature: "0x00" }, key)).toBe(false);
    });
    it("rejects noncanonical encodings and unsafe values", () => {
        for (const v of ["-1", "01", "1.5", " 1"]) expect(() => uint(v, 256)).toThrow();
        expect(() => uint(Number.MAX_SAFE_INTEGER + 1, 256)).toThrow();
        expect(() =>
            field("21888242871839275222246405745257275088548364400416034343698204186575808495617")
        ).toThrow();
    });
    it("sends public-only JSON-RPC and fails closed on generation/deployment mismatch", async () => {
        const trust: TrustContext = {
            chainId: "1",
            protocolAddress: "2",
            chainGeneration: "4",
            providerId: "5",
            manifestSha256: "a".repeat(64),
            signingKeys: { [word("6")]: new Uint8Array(32) },
        };
        let generation = "4";
        let captured: Record<string, unknown> = {};
        const transport = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            expect(String(url)).toBe("https://example.test/v1/chains/1");
            const body = JSON.parse(String(init?.body));
            captured = body;
            return new Response(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        scope: { chainId: "1", protocolAddress: "2" },
                        chainGeneration: generation,
                        providerId: "5",
                        signingKeyId: "6",
                        manifestSha256: "a".repeat(64),
                    },
                }),
                { status: 200 }
            );
        }) as typeof fetch;
        const c = new ProvenanceClient("https://example.test", trust, transport);
        await c.evaluateTransaction({ calldata: "0x12" }, []);
        expect(captured.method).toBe("provenance_evaluateTransaction");
        expect(JSON.stringify(captured)).not.toMatch(/opening|witness|nonce|privateKey/);
        generation = "5";
        await expect(c.getStatus()).rejects.toThrow("generation");
    });
});

import { readFileSync } from "node:fs";
import { ed25519 } from "@noble/curves/ed25519";
import { authenticateManifest, exportSidecar, validateProofBundle } from "./index";
it("exports only public evidence,validates certificates/binding and refuses host statement substitution", async () => {
    const bytes = readFileSync(
            new URL("../../../prover/provenance/manifest.json", import.meta.url)
        ),
        pin = "cf07e868bd354382f2137f789e6b049563289b779e061728050936d23076f31a",
        identity = authenticateManifest(bytes, pin),
        r = request(vectors.witnessK1),
        seed = new Uint8Array(32).fill(7);
    const c = {
        ...Object.fromEntries(
            Object.entries(vectors.certificate.fields).map(([k, v]) => [k, String(v)])
        ),
        chainId: r.chainId,
        protocolAddress: r.protocolAddress,
        chainGeneration: r.chainGeneration,
        treeId: "1",
        leafCount: "1",
        root: r.sources[0]!.root,
        rootSequence: "1",
        signature: "0x",
    } as RootCertificate;
    c.signature = "0x" + Buffer.from(ed25519.sign(rootCertificateMessage(c), seed)).toString("hex");
    const trust: TrustContext = {
        ...r,
        providerId: c.providerId,
        manifestSha256: pin,
        signingKeys: { [word(c.signingKeyId)]: ed25519.getPublicKey(seed) },
    };
    const proof = await exportSidecar(
        r,
        [c],
        trust,
        identity,
        { prove: async (p) => ({ proof: "0x01", publicInputs: [...p.expectedPublicInputs] }) },
        0
    );
    expect(proof.proofBundle.format).toBe("invisi-provenance-proof-v1");
    expect(proof.proofBundle.circuitId).toBe("provenance_k1");
    expect(JSON.stringify(proof)).not.toMatch(/owners|nonces|paths|witness/);
    await validateProofBundle(proof.proofBundle, trust);
    const { proofSidecarToWire } = await import("./index");
    const extraCertificate = structuredClone(proof);
    Object.assign(extraCertificate.proofBundle.rootCertificates[0]!, { selector: "unused" });
    expect(() => proofSidecarToWire(extraCertificate)).toThrow("Unknown root certificate field");
    const extraBundle = structuredClone(proof);
    Object.assign(extraBundle.proofBundle, { selector: "unused" });
    expect(() => proofSidecarToWire(extraBundle)).toThrow("Unknown proof bundle field");
    const obsolete = structuredClone(proof.proofBundle);
    obsolete.publicInputs.splice(3, 0, word(0), word(3));
    await expect(validateProofBundle(obsolete, trust)).rejects.toThrow("ABI");
    const tampered = structuredClone(proof.proofBundle);
    tampered.publicInputs[10] = word(0);
    await expect(validateProofBundle(tampered, trust)).rejects.toThrow("binding");
    await expect(
        exportSidecar(
            r,
            [c],
            trust,
            identity,
            {
                prove: async (p) => ({
                    proof: "0x01",
                    publicInputs: p.expectedPublicInputs.map((v, i) => (i === 0 ? word(1) : v)),
                }),
            },
            0
        )
    ).rejects.toThrow("statement");
    let corrupt = false;
    const transport = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const req = JSON.parse(String(init?.body));
        if (req.method === "provenance_getMembership")
            return new Response(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: req.id,
                    result: {
                        scope: {
                            chainId: r.chainId,
                            protocolAddress: r.protocolAddress,
                        },
                        chainGeneration: r.chainGeneration,
                        certificate: c,
                        commitment: vectors.note.commitment,
                        leafIndex: "0",
                        path: corrupt
                            ? r.inputs[0]!.path.map((v, i) => (i === 0 ? "1" : v))
                            : r.inputs[0]!.path,
                    },
                })
            );
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: req.id,
                result: {
                    scope: {
                        chainId: r.chainId,
                        protocolAddress: r.protocolAddress,
                    },
                    chainGeneration: r.chainGeneration,
                    certificate: c,
                    rootId: "1:1",
                    nextIndex: "1",
                    items: [
                        {
                            scope: {
                                chainId: r.chainId,
                                protocolAddress: r.protocolAddress,
                            },
                            noteCommitment: vectors.note.commitment,
                            leaf: corrupt ? "1" : vectors.note.recognizedLeaf,
                            leafIndex: "0",
                            treeId: "1",
                            chainGeneration: "1",
                            checkpointSequence: "1",
                        },
                    ],
                },
            })
        );
    }) as typeof fetch;
    const client = new ProvenanceClient("https://example.test", trust, transport);
    expect((await client.syncRecognizedTree("1:1", c)).leafCount).toBe(1);
    await expect(client.getMembership(vectors.note.commitment, "1:1")).rejects.toThrow("interest");
    expect((await client.getMembership(vectors.note.commitment, "1:1", true)).path).toEqual(
        r.inputs[0]!.path
    );
    corrupt = true;
    await expect(client.getMembership(vectors.note.commitment, "1:1", true)).rejects.toThrow(
        "root mismatch"
    );
    await expect(client.syncRecognizedTree("1:1", c)).rejects.toThrow("leaf");
});

it("requests singleton metadata and rejects another deployment", async () => {
    let wrong = false;
    const trust: TrustContext = {
        chainId: "1",
        protocolAddress: "2",
        chainGeneration: "4",
        providerId: "5",
        manifestSha256: "a".repeat(64),
        signingKeys: { [word("6")]: new Uint8Array(32) },
    };
    const transport = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const q = JSON.parse(String(init?.body));
        expect(q.params).toEqual([{}]);
        return new Response(
            JSON.stringify({
                jsonrpc: "2.0",
                id: q.id,
                result: {
                    scope: { chainId: "1", protocolAddress: wrong ? "3" : "2" },
                    chainGeneration: "4",
                },
            })
        );
    }) as typeof fetch;
    const client = new ProvenanceClient("https://example.test", trust, transport);
    await client.getVersion();
    await client.getStatus();
    wrong = true;
    await expect(client.getVersion()).rejects.toThrow("Deployment mismatch");
    await expect(client.getStatus()).rejects.toThrow("Deployment mismatch");
});

it("waitProofJob terminates after one stale_generation response and rejects unknown job states", async () => {
    for (const status of ["stale_generation", "unknown_status"]) {
        let calls = 0;
        const trust: TrustContext = {
            chainId: "1",
            protocolAddress: "2",
            chainGeneration: "2",
            providerId: "5",
            manifestSha256: "a".repeat(64),
            signingKeys: { [word(6)]: new Uint8Array(32) },
        };
        const transport = (async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
            calls++;
            if (calls > 1) throw Error("unexpected second request");
            const q = JSON.parse(String(init?.body));
            return new Response(
                JSON.stringify({
                    jsonrpc: "2.0",
                    id: q.id,
                    result: {
                        scope: { chainId: "1", protocolAddress: "2" },
                        chainGeneration: "2",
                        providerId: "5",
                        signingKeyId: "6",
                        manifestSha256: trust.manifestSha256,
                        status,
                    },
                })
            );
        }) as typeof fetch;
        const client = new ProvenanceClient("https://example.test", trust, transport);
        if (status === "stale_generation")
            expect(
                (await client.waitProofJob("job", { intervalMs: 1, timeoutMs: 20 })).status
            ).toBe(status);
        else
            await expect(
                client.waitProofJob("job", { intervalMs: 1, timeoutMs: 20 })
            ).rejects.toThrow("status");
        expect(calls).toBe(1);
    }
});
