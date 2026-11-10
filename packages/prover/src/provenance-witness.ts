import { sha256 } from "@noble/hashes/sha256";
import { hexlify } from "ethers";
import { poseidonHash } from "@invisi-labs/primitives";
import {
    CAPACITIES,
    PUBLIC_INPUTS,
    field,
    uint,
    word,
    scopeHash,
    sourcesDigest,
    noteOpening,
    recognizedLeaf,
    inputDigest,
    limbs,
    bindingDigest,
    assertCertificateTrust,
    certificateToWire,
    type Scope,
    type Opening,
    type Source,
    type Integer,
    type RootCertificate,
    type TrustContext,
    type ProofSidecar,
    type ManifestIdentity,
    type TrustedManifest,
} from "@invisi-labs/protocol/provenance";
const hash = async (v: Integer[]) => BigInt(await poseidonHash(v.map(field)));
export interface WitnessInput extends Opening {
    sourceIndex: number;
    leafIndex: Integer;
    path: readonly Integer[];
}
export interface WitnessRequest extends Scope {
    capacity: number;
    tokenAddress: Integer;
    chainGeneration: Integer;
    operationDigest: Integer;
    inputs: readonly WitnessInput[];
    sources: readonly Source[];
}
export type Witness = Record<string, bigint | bigint[] | bigint[][]>;
export async function buildWitness(s: WitnessRequest): Promise<Witness> {
    if (
        !CAPACITIES.includes(s.capacity) ||
        !s.inputs.length ||
        s.inputs.length > s.capacity ||
        !s.sources.length ||
        s.sources.length > s.inputs.length
    )
        throw new Error("Invalid provenance shape");
    const scope = await scopeHash(s),
        sd = await sourcesDigest(s.chainGeneration, s.sources),
        ns: bigint[] = [];
    const w: Witness = {
        owners: [],
        nonces: [],
        amounts: [],
        source_indices: [],
        leaf_indices: [],
        paths: [],
        tree_ids: s.sources.map((x) => uint(x.treeId, 64)),
        roots: s.sources.map((x) => field(x.root)),
        leaf_counts: s.sources.map((x) => uint(x.leafCount, 64)),
    };
    const used = new Set<number>();
    for (const i of s.inputs) {
        if (
            !Number.isInteger(i.sourceIndex) ||
            i.sourceIndex < 0 ||
            i.sourceIndex >= s.sources.length ||
            i.path.length !== 32 ||
            uint(i.leafIndex, 32) >= BigInt(s.sources[i.sourceIndex]!.leafCount)
        )
            throw new Error("Invalid input path");
        used.add(i.sourceIndex);
        const o = await noteOpening({ ...s, ...i });
        let n = await recognizedLeaf(scope, o.commitment);
        for (let j = 0; j < 32; j++)
            n = await hash(
                (BigInt(i.leafIndex) >> BigInt(j)) & 1n ? [i.path[j]!, n] : [n, i.path[j]!]
            );
        if (n !== BigInt(s.sources[i.sourceIndex]!.root)) throw new Error("Membership mismatch");
        if (ns.includes(o.nullifier)) throw new Error("Duplicate input");
        ns.push(o.nullifier);
        for (const [k, v] of Object.entries({
            owners: i.owner,
            nonces: i.nonce,
            amounts: i.amount,
            source_indices: i.sourceIndex,
            leaf_indices: i.leafIndex,
        }))
            (w[k] as bigint[]).push(BigInt(v));
        (w.paths as bigint[][]).push(i.path.map(field));
    }
    if (used.size !== s.sources.length) throw new Error("Unused source");
    const id = await inputDigest(ns),
        p = [
            s.chainId,
            s.protocolAddress,
            s.tokenAddress,
            s.chainGeneration,
            s.sources.length,
            sd,
            s.inputs.length,
            ...limbs(s.operationDigest),
            id,
            await bindingDigest({
                scope,
                tokenAddress: s.tokenAddress,
                chainGeneration: s.chainGeneration,
                sourceCount: s.sources.length,
                sourcesDigest: sd,
                inputCount: s.inputs.length,
                operationDigest: s.operationDigest,
                inputDigest: id,
            }),
        ];
    PUBLIC_INPUTS.forEach((key, i) => (w[key] = field(p[i]!)));
    for (const key of [
        "owners",
        "nonces",
        "amounts",
        "source_indices",
        "leaf_indices",
        "tree_ids",
        "roots",
        "leaf_counts",
    ])
        while ((w[key] as bigint[]).length < s.capacity) (w[key] as bigint[]).push(0n);
    while ((w.paths as bigint[][]).length < s.capacity)
        (w.paths as bigint[][]).push(Array<bigint>(32).fill(0n));
    return w;
}
export const witnessJSON = (w: Witness): string =>
    JSON.stringify(w, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
export function authenticateManifest(bytes: Uint8Array, expectedSha256: string): ManifestIdentity {
    if (
        !/^[a-f0-9]{64}$/.test(expectedSha256) ||
        hexlify(sha256(bytes)).slice(2) !== expectedSha256
    )
        throw new Error("Manifest mismatch");
    const m = JSON.parse(new TextDecoder().decode(bytes)) as TrustedManifest;
    if (
        m.family !== "provenance" ||
        m.target !== "evm" ||
        m.noirVersion !== "1.0.0" ||
        m.bbVersion !== "6.0.0" ||
        m.depth !== 32 ||
        JSON.stringify(m.publicInputs) !== JSON.stringify(PUBLIC_INPUTS) ||
        m.circuits.length !== CAPACITIES.length ||
        !CAPACITIES.every((k) => m.circuits.filter((e) => e.capacity === k).length === 1)
    )
        throw new Error("Unsupported provenance manifest");
    return { manifest: m, sha256: expectedSha256 };
}
export interface OfflineProver {
    prove(request: {
        identity: ManifestIdentity;
        capacity: number;
        witness: Witness;
        expectedPublicInputs: readonly string[];
    }): Promise<{ proof: string; publicInputs: string[] }>;
}
export async function exportSidecar(
    request: WitnessRequest,
    certificates: readonly RootCertificate[],
    trust: TrustContext,
    identity: ManifestIdentity,
    prover: OfflineProver,
    operationIndex: Integer
): Promise<ProofSidecar> {
    if (identity.sha256 !== trust.manifestSha256 || certificates.length !== request.sources.length)
        throw new Error("Manifest or certificate count mismatch");
    for (const k of ["chainId", "protocolAddress", "chainGeneration"] as const)
        if (BigInt(request[k]) !== BigInt(trust[k])) throw new Error("Witness deployment mismatch");
    certificates.forEach((c, i) => {
        assertCertificateTrust(c, trust);
        const s = request.sources[i]!;
        if (
            BigInt(c.treeId) !== BigInt(s.treeId) ||
            BigInt(c.root) !== BigInt(s.root) ||
            BigInt(c.leafCount) !== BigInt(s.leafCount)
        )
            throw new Error("Certificate source mismatch");
    });
    const witness = await buildWitness(request),
        expected = PUBLIC_INPUTS.map((k) => word(witness[k] as bigint));
    const result = await prover.prove({
        identity,
        capacity: request.capacity,
        witness,
        expectedPublicInputs: expected,
    });
    if (
        result.publicInputs.length !== 11 ||
        result.publicInputs.some((v, i) => word(field(v)) !== expected[i]) ||
        !/^0x(?:[0-9a-fA-F]{2})+$/.test(result.proof) ||
        result.proof.length > 131074
    )
        throw new Error("Offline prover returned invalid statement or proof");
    return {
        operationIndex: uint(operationIndex, 32).toString(),
        proofBundle: {
            format: "invisi-provenance-proof-v1",
            circuitId: `provenance_k${request.capacity}`,
            manifestSha256: identity.sha256,
            target: "evm",
            publicInputs: expected,
            proof: result.proof,
            rootCertificates: certificates.map(certificateToWire),
        },
    };
}

export interface ProvenanceCapability {
    manifest: ManifestIdentity;
    prover: OfflineProver;
}
export interface ProvenanceProvider {
    getProvenanceCapability(): Promise<ProvenanceCapability>;
}
