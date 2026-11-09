import { validateTracking, type TrackingResult } from "./tracking";
import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { AbiCoder, keccak256, getBytes, hexlify, concat } from "ethers";
import { poseidonHash } from "../crypto/poseidon";

export type Integer = bigint | string | number;
export const FIELD_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const CAPACITIES: readonly number[] = Object.freeze([
    ...Array.from({ length: 10 }, (_, i) => i + 1),
    ...Array.from({ length: 18 }, (_, i) => (i + 2) * 10),
]);
export const PUBLIC_INPUTS = Object.freeze([
    "chain_id",
    "protocol_address",
    "token_address",
    "policy_id_hi",
    "policy_id_lo",
    "chain_generation",
    "source_count",
    "sources_digest",
    "input_count",
    "operation_digest_hi",
    "operation_digest_lo",
    "input_digest",
    "binding",
] as const);
const utf8 = (s: string) => new TextEncoder().encode(s);
export function uint(value: Integer, bits: number): bigint {
    if (typeof value === "number" && !Number.isSafeInteger(value))
        throw new Error("Unsafe integer");
    if (typeof value === "string" && !/^(0|[1-9][0-9]*|0x[0-9a-fA-F]+)$/.test(value))
        throw new Error("Invalid integer encoding");
    const n = BigInt(value);
    if (n < 0n || n >= 1n << BigInt(bits)) throw new Error(`Integer exceeds u${bits}`);
    return n;
}
export function field(value: Integer): bigint {
    const n = uint(value, 256);
    if (n >= FIELD_MODULUS) throw new Error("Noncanonical field");
    return n;
}
export const word = (value: Integer): string =>
    "0x" + uint(value, 256).toString(16).padStart(64, "0");
export const DOMAINS = Object.freeze(
    Object.fromEntries(
        Object.entries({
            SCOPE: "Scope",
            NOTE: "Note",
            INPUTS: "Inputs",
            STEP: "Step",
            SOURCES: "Sources",
            SOURCE_STEP: "SourceStep",
            BIND: "Bind",
        }).map(([k, v]) => [
            k,
            BigInt(hexlify(sha256(utf8(`Invisi.Provenance.${v}.v1`)))) % FIELD_MODULUS,
        ])
    ) as Record<"SCOPE" | "NOTE" | "INPUTS" | "STEP" | "SOURCES" | "SOURCE_STEP" | "BIND", bigint>
);
const hash = async (values: Integer[]): Promise<bigint> =>
    BigInt(await poseidonHash(values.map(field)));
export const limbs = (value: Integer): [bigint, bigint] => {
    const n = uint(value, 256);
    return [n >> 128n, n & ((1n << 128n) - 1n)];
};
export interface Scope {
    chainId: Integer;
    protocolAddress: Integer;
    policyId: Integer;
}
export async function scopeHash(s: Scope): Promise<bigint> {
    const protocol = uint(s.protocolAddress, 160);
    if (!protocol) throw new Error("Zero protocol");
    return hash([DOMAINS.SCOPE, uint(s.chainId, 64), protocol, ...limbs(s.policyId)]);
}
export const recognizedLeaf = (scope: Integer, commitment: Integer): Promise<bigint> => {
    if (field(commitment) === 0n) throw new Error("Zero commitment");
    return hash([DOMAINS.NOTE, scope, commitment]);
};
export interface Opening {
    owner: Integer;
    nonce: Integer;
    amount: Integer;
}
export async function noteOpening(
    s: Pick<Scope, "chainId" | "protocolAddress"> & Opening & { tokenAddress: Integer }
): Promise<{ commitment: bigint; nullifier: bigint }> {
    const owner = uint(s.owner, 160),
        amount = uint(s.amount, 128),
        chain = uint(s.chainId, 64),
        protocol = uint(s.protocolAddress, 160),
        token = uint(s.tokenAddress, 160),
        nonce = field(s.nonce);
    if (!owner || !amount || !protocol || !token)
        throw new Error("Zero note owner, protocol, token or amount");
    const identity = await hash([2n, owner, nonce]);
    const commitment = await hash([3n, chain, protocol, identity, token, amount]);
    return { commitment, nullifier: await hash([4n, chain, protocol, nonce, commitment]) };
}
export async function inputDigest(nullifiers: readonly Integer[]): Promise<bigint> {
    let d = await hash([DOMAINS.INPUTS, nullifiers.length]);
    for (const n of nullifiers) d = await hash([DOMAINS.STEP, d, n]);
    return d;
}
export interface Source {
    treeId: Integer;
    root: Integer;
    leafCount: Integer;
}
export async function sourcesDigest(
    generation: Integer,
    sources: readonly Source[]
): Promise<bigint> {
    let d = await hash([DOMAINS.SOURCES, uint(generation, 64), sources.length]),
        prior = 0n;
    for (const s of sources) {
        const id = uint(s.treeId, 64),
            count = uint(s.leafCount, 64);
        if (id <= prior || count < 1n || count > 2n ** 32n)
            throw new Error("Invalid source order or count");
        prior = id;
        d = await hash([DOMAINS.SOURCE_STEP, d, id, s.root, count]);
    }
    return d;
}
export async function bindingDigest(s: {
    scope: Integer;
    tokenAddress: Integer;
    chainGeneration: Integer;
    sourceCount: Integer;
    sourcesDigest: Integer;
    inputCount: Integer;
    operationDigest: Integer;
    inputDigest: Integer;
}): Promise<bigint> {
    return hash([
        DOMAINS.BIND,
        s.scope,
        (() => {
            const token = uint(s.tokenAddress, 160);
            if (!token) throw new Error("Zero token");
            return token;
        })(),
        uint(s.chainGeneration, 64),
        s.sourceCount,
        s.sourcesDigest,
        s.inputCount,
        ...limbs(s.operationDigest),
        s.inputDigest,
    ]);
}
export function operationDigest(s: {
    chainId: Integer;
    protocolAddress: Integer;
    operationKind?: number;
    mainCircuitCapacity: Integer;
    publicInputs: readonly Integer[];
}): string {
    const chain = uint(s.chainId, 64),
        protocol = uint(s.protocolAddress, 160),
        capacity = Number(uint(s.mainCircuitCapacity, 32));
    if (
        !protocol ||
        !Number.isInteger(capacity) ||
        capacity < 1 ||
        capacity > 190 ||
        s.publicInputs.length !== 17 + 3 * capacity ||
        (s.operationKind ?? 2) !== 2
    )
        throw new Error("Invalid authenticated transact statement");
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["string", "uint64", "address", "uint8", "uint32", "bytes32[]"],
            [
                "Invisi.Provenance.Operation.v1",
                chain,
                "0x" + protocol.toString(16).padStart(40, "0"),
                2,
                capacity,
                s.publicInputs.map((x) => word(field(x))),
            ]
        )
    );
}
const CERT_LAYOUT = [
    ["certificateVersion", 1],
    ["providerId", 32],
    ["signingKeyId", 32],
    ["policyId", 32],
    ["chainId", 8],
    ["protocolAddress", 20],
    ["chainGeneration", 8],
    ["rootSequence", 8],
    ["treeId", 8],
    ["leafCount", 8],
    ["root", 32],
    ["confirmedBlockNumber", 8],
    ["confirmedBlockHash", 32],
    ["decisionLogHash", 32],
    ["previousCheckpointHash", 32],
    ["issuedAt", 8],
] as const;
export type RootCertificate = Record<(typeof CERT_LAYOUT)[number][0], Integer> & {
    signature: string;
};
export function rootCertificatePayload(c: Omit<RootCertificate, "signature">): Uint8Array {
    if (
        uint(c.certificateVersion, 8) !== 1n ||
        uint(c.treeId, 64) < 1n ||
        uint(c.leafCount, 64) > 2n ** 32n
    )
        throw new Error("Invalid certificate version or tree");
    field(c.root);
    return getBytes(
        concat(
            CERT_LAYOUT.map(
                ([k, w]) =>
                    "0x" +
                    uint(c[k], w * 8)
                        .toString(16)
                        .padStart(w * 2, "0")
            )
        )
    );
}
export const checkpointHash = (c: Omit<RootCertificate, "signature">): string =>
    hexlify(sha256(rootCertificatePayload(c))).slice(2);
export const rootCertificateMessage = (c: Omit<RootCertificate, "signature">): Uint8Array =>
    sha256(getBytes(concat([utf8("Invisi.Provenance.Root.v1"), rootCertificatePayload(c)])));
export function verifyRootCertificate(c: RootCertificate, key: Uint8Array): boolean {
    if (!/^0x[0-9a-fA-F]{128}$/.test(c.signature) || key.length !== 32) return false;
    try {
        return ed25519.verify(getBytes(c.signature), rootCertificateMessage(c), key, {
            zip215: false,
        });
    } catch {
        return false;
    }
}
export class RecognizedTree {
    private readonly leaves: bigint[] = [];
    get leafCount(): number {
        return this.leaves.length;
    }
    append(value: Integer): number {
        const leaf = field(value);
        if (!leaf || this.leaves.length >= 2 ** 32) throw new Error("Invalid leaf or full tree");
        this.leaves.push(leaf);
        return this.leaves.length - 1;
    }
    async appendCommitment(scope: Scope, commitment: Integer): Promise<number> {
        return this.append(await recognizedLeaf(await scopeHash(scope), commitment));
    }
    async membershipForCommitment(
        scope: Scope,
        commitment: Integer
    ): Promise<{ leafIndex: number; path: bigint[]; root: bigint } | undefined> {
        const leaf = await recognizedLeaf(await scopeHash(scope), commitment),
            index = this.leaves.indexOf(leaf);
        if (index < 0) return undefined;
        return { leafIndex: index, ...(await this.path(index)) };
    }
    async root(): Promise<bigint> {
        if (this.leaves.length) return (await this.path(0)).root;
        let zero = 0n;
        for (let i = 0; i < 32; i++) zero = await hash([zero, zero]);
        return zero;
    }
    async path(index: number): Promise<{ path: bigint[]; root: bigint }> {
        if (!Number.isInteger(index) || index < 0 || index >= this.leaves.length)
            throw new Error("Leaf index");
        let zero = 0n,
            nodes = new Map(this.leaves.map((v, i) => [i, v])),
            cursor = index;
        const path: bigint[] = [];
        for (let l = 0; l < 32; l++) {
            path.push(nodes.get(cursor % 2 === 0 ? cursor + 1 : cursor - 1) ?? zero);
            const next = new Map<number, bigint>();
            for (const i of nodes.keys()) {
                const p = Math.floor(i / 2);
                if (!next.has(p))
                    next.set(
                        p,
                        await hash([nodes.get(p * 2) ?? zero, nodes.get(p * 2 + 1) ?? zero])
                    );
            }
            zero = await hash([zero, zero]);
            nodes = next;
            cursor = Math.floor(cursor / 2);
        }
        return { path, root: nodes.get(0) ?? zero };
    }
}
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
            ...limbs(s.policyId),
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
export interface ProofBundle {
    format: "invisi-provenance-proof-v1";
    circuitId: string;
    manifestSha256: string;
    target: "evm";
    publicInputs: string[];
    proof: string;
    rootCertificates: RootCertificate[];
}
export interface ProofSidecar {
    operationIndex: string;
    proofBundle: ProofBundle;
}
export interface TrustedManifest {
    noirVersion: string;
    bbVersion: string;
    depth: number;
    family: "provenance";
    target: "evm";
    publicInputs: readonly string[];
    circuits: readonly {
        capacity: number;
        name?: string;
        artifactSha256: string;
        vkSha256: string;
    }[];
}
export interface ManifestIdentity {
    manifest: TrustedManifest;
    sha256: string;
}
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
export interface TrustContext extends Scope {
    chainGeneration: Integer;
    providerId: Integer;
    signingKeys: Readonly<Record<string, Uint8Array>>;
    manifestSha256: string;
    signingKeyValidity?: Readonly<Record<string, { activatedAt: string; retiredAt?: string }>>;
}
export function assertCertificateTrust(c: RootCertificate, trust: TrustContext): void {
    for (const k of [
        "chainId",
        "protocolAddress",
        "policyId",
        "chainGeneration",
        "providerId",
    ] as const)
        if (BigInt(c[k]) !== BigInt(trust[k])) throw new Error("Certificate deployment mismatch");
    const key = trust.signingKeys[word(c.signingKeyId)];
    const validity = trust.signingKeyValidity?.[word(c.signingKeyId)],
        issuedAt = uint(c.issuedAt, 64);
    if (
        validity &&
        (issuedAt < BigInt(validity.activatedAt) ||
            (validity.retiredAt !== undefined && issuedAt >= BigInt(validity.retiredAt)))
    )
        throw new Error("Certificate outside signing key validity");
    if (!key || !verifyRootCertificate(c, key)) throw new Error("Untrusted certificate signature");
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
    for (const k of ["chainId", "protocolAddress", "policyId", "chainGeneration"] as const)
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
        result.publicInputs.length !== 13 ||
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

export function provenanceIntentHash(originalRequestHash: string, policyId: Integer): string {
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["string", "bytes32", "bytes32"],
            ["InvisiBroadcasterProvenanceIntentV1", word(originalRequestHash), word(policyId)]
        )
    );
}
export type PublicResult = Record<string, unknown> & { scope: Scope };
export class ProvenanceClient {
    private sequence = 0;
    constructor(
        readonly endpoint: string,
        readonly trust: TrustContext,
        private readonly transport: typeof fetch = fetch
    ) {
        const u = new URL(endpoint);
        if (
            !["http:", "https:"].includes(u.protocol) ||
            u.search ||
            u.hash ||
            u.username ||
            u.password
        )
            throw new Error("Invalid service endpoint");
        uint(trust.chainId, 64);
        uint(trust.protocolAddress, 160);
        uint(trust.policyId, 256);
    }
    private async call<T extends PublicResult>(
        method: string,
        query?: Record<string, unknown>,
        signal?: AbortSignal
    ): Promise<T> {
        assertPublicSubmission(query);
        const id = ++this.sequence;
        const response = await this.transport(
            this.endpoint.replace(/\/$/, "") + `/v1/chains/${uint(this.trust.chainId, 64)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id, method, params: query ? [query] : [] }),
                ...(signal ? { signal } : {}),
            }
        );
        if (!response.ok) throw new Error(`Provenance HTTP ${response.status}`);
        const envelope = (await response.json()) as {
            jsonrpc?: string;
            id?: number;
            result?: T;
            error?: { message: string; data?: { code: string } };
        };
        if (envelope.jsonrpc !== "2.0" || envelope.id !== id)
            throw new Error("Invalid JSON-RPC response");
        if (envelope.error) throw new Error(envelope.error.data?.code ?? envelope.error.message);
        const result = envelope.result;
        if (!result?.scope) throw new Error("Missing deployment scope");
        if (
            [
                "provenance_evaluateTransaction",
                "provenance_submitProof",
                "provenance_getProofJob",
                "provenance_getTracking",
            ].includes(method) &&
            ["chainGeneration", "providerId", "signingKeyId", "manifestSha256"].some(
                (k) => result[k] === undefined
            )
        )
            throw new Error("Missing response trust identity");
        for (const k of ["chainId", "protocolAddress", "policyId"] as const)
            if (BigInt(result.scope[k]) !== BigInt(this.trust[k]))
                throw new Error("Deployment mismatch");
        if (
            result.chainGeneration !== undefined &&
            BigInt(result.chainGeneration as string) !== BigInt(this.trust.chainGeneration)
        )
            throw new Error("Chain generation changed");
        if (
            result.providerId !== undefined &&
            BigInt(result.providerId as string) !== BigInt(this.trust.providerId)
        )
            throw new Error("Provider mismatch");
        if (
            result.manifestSha256 !== undefined &&
            result.manifestSha256 !== this.trust.manifestSha256
        )
            throw new Error("Manifest mismatch");
        if (result.signingKeyId !== undefined) {
            const id = word(result.signingKeyId as string);
            if (method !== "provenance_getPolicy" && !this.trust.signingKeys[id])
                throw new Error("Untrusted signing key");
        }
        return result;
    }
    getVersion(signal?: AbortSignal): Promise<PublicResult> {
        return this.call("provenance_getVersion", { policyId: word(this.trust.policyId) }, signal);
    }
    getStatus(signal?: AbortSignal): Promise<PublicResult> {
        return this.call("provenance_getStatus", { policyId: word(this.trust.policyId) }, signal);
    }
    getPolicies(query: Record<string, unknown> = {}): Promise<PublicResult> {
        return this.call("provenance_getPolicies", query);
    }
    getPolicy(): Promise<PublicResult> {
        return this.call("provenance_getPolicy", { policyId: word(this.trust.policyId) });
    }
    async getRoots(query: Record<string, unknown> = {}): Promise<PublicResult> {
        const r = await this.call("provenance_getRoots", {
            ...query,
            policyId: word(this.trust.policyId),
        });
        if (!Array.isArray(r.items)) throw new Error("Missing root certificates");
        for (const c of r.items) assertCertificateTrust(c as RootCertificate, this.trust);
        return r;
    }
    async getRoot(rootId: string): Promise<PublicResult> {
        const r = await this.call<PublicResult>("provenance_getRoot", {
            policyId: word(this.trust.policyId),
            rootId,
        });
        if (r.certificate) assertCertificateTrust(r.certificate as RootCertificate, this.trust);
        return r;
    }
    getLeaves(rootId: string, fromIndex: string, limit = 50): Promise<PublicResult> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Page limit");
        return this.call("provenance_getLeaves", {
            policyId: word(this.trust.policyId),
            rootId,
            fromIndex: uint(fromIndex, 64).toString(),
            limit,
        });
    }
    async getMembership(
        commitment: string,
        rootId: string,
        allowInterestDisclosure = false
    ): Promise<PublicResult> {
        if (!allowInterestDisclosure)
            throw new Error("Membership lookup requires explicit interest disclosure");
        const requested = field(commitment),
            r = await this.call("provenance_getMembership", {
                policyId: word(this.trust.policyId),
                commitment: word(requested),
                rootId,
            });
        const certificate = r.certificate as RootCertificate;
        assertCertificateTrust(certificate, this.trust);
        if (
            !Array.isArray(r.path) ||
            r.path.length !== 32 ||
            field(r.commitment as string) !== requested
        )
            throw new Error("Invalid membership response");
        const index = uint(r.leafIndex as string, 32);
        if (index >= BigInt(certificate.leafCount))
            throw new Error("Membership index outside certified prefix");
        let leaf = await recognizedLeaf(await scopeHash(this.trust), requested);
        for (let level = 0; level < 32; level++) {
            const sibling = field(r.path[level] as string);
            leaf = await hash((index >> BigInt(level)) & 1n ? [sibling, leaf] : [leaf, sibling]);
        }
        if (leaf !== BigInt(certificate.root)) throw new Error("Membership root mismatch");
        return r;
    }
    async syncRecognizedTree(
        rootId: string,
        certificate: RootCertificate,
        options: { limit?: number; maxLeaves?: number } = {}
    ): Promise<RecognizedTree> {
        assertCertificateTrust(certificate, this.trust);
        const count = uint(certificate.leafCount, 64),
            max = options.maxLeaves ?? 100000;
        if (count > BigInt(max) || !Number.isSafeInteger(max) || max < 1)
            throw new Error("Local tree replay exceeds configured leaf budget");
        const tree = new RecognizedTree(),
            scope = await scopeHash(this.trust);
        let from = 0n;
        while (from < count) {
            const result = await this.getLeaves(rootId, from.toString(), options.limit ?? 200);
            if (
                result.rootId !== rootId ||
                !result.certificate ||
                checkpointHash(result.certificate as RootCertificate) !==
                    checkpointHash(certificate) ||
                !Array.isArray(result.items) ||
                !result.items.length
            )
                throw new Error("Root snapshot changed or incomplete leaf page");
            assertCertificateTrust(result.certificate as RootCertificate, this.trust);
            for (const raw of result.items) {
                const leaf = raw as {
                    scope: Scope;
                    noteCommitment: Integer;
                    leaf: Integer;
                    chainGeneration: Integer;
                    treeId: Integer;
                    leafIndex: Integer;
                    checkpointSequence: Integer;
                };
                for (const k of ["chainId", "protocolAddress", "policyId"] as const)
                    if (BigInt(leaf.scope[k]) !== BigInt(this.trust[k]))
                        throw new Error("Leaf scope mismatch");
                if (
                    from >= count ||
                    uint(leaf.leafIndex, 32) !== from ||
                    BigInt(leaf.chainGeneration) !== BigInt(certificate.chainGeneration) ||
                    BigInt(leaf.treeId) !== BigInt(certificate.treeId) ||
                    uint(leaf.checkpointSequence, 64) > BigInt(certificate.rootSequence) ||
                    field(leaf.leaf) !== (await recognizedLeaf(scope, leaf.noteCommitment))
                )
                    throw new Error("Invalid recognized leaf page");
                tree.append(leaf.leaf);
                from++;
            }
            if (result.nextIndex !== from.toString()) throw new Error("Noncontiguous leaf cursor");
        }
        if ((await tree.root()) !== BigInt(certificate.root))
            throw new Error("Rebuilt root mismatch");
        return tree;
    }
    getNoteRecognition(commitment: string): Promise<PublicResult> {
        return this.call("provenance_getNoteRecognition", {
            policyId: word(this.trust.policyId),
            commitment: word(field(commitment)),
        });
    }
    getOperationRecognition(locator: Record<string, string>): Promise<PublicResult> {
        return this.call("provenance_getOperationRecognition", {
            ...locator,
            policyId: word(this.trust.policyId),
        });
    }
    getTransactionRecognition(txHash: string): Promise<PublicResult> {
        return this.call("provenance_getTransactionRecognition", {
            policyId: word(this.trust.policyId),
            txHash: word(txHash),
        });
    }
    async evaluateTransaction(
        data: unknown,
        proofSidecars: readonly ProofSidecar[]
    ): Promise<PublicResult> {
        assertPublicSubmission({ data, proofSidecars });
        for (const s of proofSidecars) {
            uint(s.operationIndex, 32);
            await validateProofBundle(s.proofBundle, this.trust);
        }
        return this.call("provenance_evaluateTransaction", {
            policyId: word(this.trust.policyId),
            data,
            proofSidecars: proofSidecars.map(proofSidecarToWire),
        });
    }
    async submitProof(
        locator: Record<string, string>,
        proofBundle: ProofBundle,
        idempotencyKey: string
    ): Promise<PublicResult> {
        if (!idempotencyKey) throw new Error("Idempotency key required");
        if (idempotencyKey.startsWith("internal/")) throw Error("reserved idempotency key prefix");
        assertPublicSubmission(proofBundle);
        await validateProofBundle(proofBundle, this.trust);
        return this.call("provenance_submitProof", {
            ...locator,
            policyId: word(this.trust.policyId),
            proofBundle: proofSidecarToWire({ operationIndex: "0", proofBundle }).proofBundle,
            idempotencyKey,
        });
    }
    async getTracking(trackingId: string, signal?: AbortSignal): Promise<TrackingResult> {
        if (!/^[a-f0-9]{48}$/.test(trackingId)) throw Error("Invalid tracking id");
        const result = await this.call(
            "provenance_getTracking",
            { policyId: word(this.trust.policyId), trackingId },
            signal
        );
        const tracking = validateTracking(result.tracking, trackingId);
        return { ...result, tracking };
    }
    async waitTracking(
        trackingId: string,
        options: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {}
    ): Promise<TrackingResult> {
        const interval = options.intervalMs ?? 1000,
            timeout = options.timeoutMs ?? 120000;
        if (
            !Number.isFinite(timeout) ||
            timeout < 1 ||
            !Number.isFinite(interval) ||
            interval < 1 ||
            interval > 60000
        )
            throw Error("Tracking polling limits");
        const deadline = Date.now() + timeout;
        for (;;) {
            options.signal?.throwIfAborted();
            const controller = new AbortController();
            const abort = () => controller.abort(options.signal?.reason);
            options.signal?.addEventListener("abort", abort, { once: true });
            const requestTimer = setTimeout(
                () => controller.abort(Error("Tracking wait timeout")),
                Math.max(1, deadline - Date.now())
            );
            let result: TrackingResult;
            try {
                result = await this.getTracking(trackingId, controller.signal);
            } finally {
                clearTimeout(requestTimer);
                options.signal?.removeEventListener("abort", abort);
            }

            if (["recognized", "expired", "superseded"].includes(result.tracking.status))
                return result;
            if (Date.now() >= deadline) throw Error("Tracking wait timeout");
            await new Promise<void>((resolve, reject) => {
                const timer = setTimeout(
                    () => {
                        options.signal?.removeEventListener("abort", abort);
                        resolve();
                    },
                    Math.min(interval, deadline - Date.now())
                );
                const abort = () => {
                    clearTimeout(timer);
                    reject(Error("Tracking wait cancelled"));
                };
                options.signal?.addEventListener("abort", abort, { once: true });
                if (options.signal?.aborted) abort();
            });
        }
    }
    getProofJob(jobId: string, signal?: AbortSignal): Promise<PublicResult> {
        return this.call("provenance_getProofJob", { jobId }, signal);
    }
    async waitProofJob(
        jobId: string,
        options: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {}
    ): Promise<PublicResult> {
        const deadline = Date.now() + (options.timeoutMs ?? 120000),
            interval = options.intervalMs ?? 1000;
        if (interval < 1 || interval > 60000) throw new Error("Poll interval");
        for (;;) {
            options.signal?.throwIfAborted();
            const job = await this.getProofJob(jobId, options.signal);
            if (
                ["valid", "invalid", "retryable_error", "stale_generation"].includes(
                    String(job.status)
                )
            )
                return job;
            if (!["queued", "verifying"].includes(String(job.status)))
                throw Error("Unsupported proof job status");
            if (Date.now() >= deadline) throw new Error("Proof job wait timeout");
            await new Promise<void>((resolve, reject) => {
                const onAbort = () => {
                    clearTimeout(timer);
                    reject(options.signal?.reason ?? new Error("Aborted"));
                };
                const timer = setTimeout(
                    () => {
                        options.signal?.removeEventListener("abort", onAbort);
                        resolve();
                    },
                    Math.min(interval, deadline - Date.now())
                );
                options.signal?.addEventListener("abort", onAbort, { once: true });
            });
        }
    }
}

function assertPublicSubmission(value: unknown): void {
    if (value === null || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
        if (
            /^(opening|openings|nonce|nonces|privateKey|private_key|ipn|witness|owners|amounts|paths|artifactUrl|vkUrl|verificationKey)$/i.test(
                key
            )
        )
            throw new Error(
                "Private or executable material is not allowed in provenance submissions"
            );
        assertPublicSubmission(item);
    }
}

export function certificateToWire(c: RootCertificate): RootCertificate {
    rootCertificatePayload(c);
    const out = {} as RootCertificate;
    for (const [key, width] of CERT_LAYOUT) {
        const n = uint(c[key], width * 8);
        out[key] =
            width === 32 || key === "protocolAddress"
                ? "0x" + n.toString(16).padStart(width * 2, "0")
                : n.toString();
    }
    if (!/^0x[0-9a-fA-F]{128}$/.test(c.signature))
        throw new Error("Certificate signature encoding");
    out.signature = c.signature.toLowerCase();
    return out;
}

export async function validateProofBundle(b: ProofBundle, t: TrustContext): Promise<void> {
    const keys = [
        "format",
        "circuitId",
        "manifestSha256",
        "target",
        "publicInputs",
        "proof",
        "rootCertificates",
    ];
    if (
        Object.keys(b).some((k) => !keys.includes(k)) ||
        b.format !== "invisi-provenance-proof-v1" ||
        b.target !== "evm" ||
        b.manifestSha256 !== t.manifestSha256 ||
        !/^0x(?:[0-9a-fA-F]{2})+$/.test(b.proof) ||
        b.proof.length > 131074
    )
        throw new Error("Unsupported provenance proof bundle");
    const match = /^provenance_k([1-9][0-9]*)$/.exec(b.circuitId),
        capacity = Number(match?.[1]);
    if (!CAPACITIES.includes(capacity) || b.publicInputs.length !== 13)
        throw new Error("Unsupported provenance circuit or ABI");
    const p = b.publicInputs.map((v) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(v))
            throw new Error("Public inputs must be canonical words");
        return field(v);
    });
    const [hi, lo] = limbs(t.policyId);
    uint(p[9]!, 128);
    uint(p[10]!, 128);
    if (
        p[0] !== BigInt(t.chainId) ||
        p[1] !== BigInt(t.protocolAddress) ||
        p[3] !== hi ||
        p[4] !== lo ||
        p[5] !== BigInt(t.chainGeneration) ||
        p[6] !== BigInt(b.rootCertificates.length) ||
        p[8]! < 1n ||
        p[8]! > BigInt(capacity) ||
        p[6]! < 1n ||
        p[6]! > p[8]!
    )
        throw new Error("Proof bundle scope or shape mismatch");
    const sources = b.rootCertificates.map((c) => {
        if (
            Object.keys(c).some(
                (k) => k !== "signature" && !CERT_LAYOUT.some(([name]) => name === k)
            )
        )
            throw new Error("Unknown root certificate field");
        assertCertificateTrust(c, t);
        return { treeId: c.treeId, root: c.root, leafCount: c.leafCount };
    });
    const sd = await sourcesDigest(t.chainGeneration, sources);
    if (sd !== p[7]) throw new Error("Proof sources digest mismatch");
    const binding = await bindingDigest({
        scope: await scopeHash(t),
        tokenAddress: p[2]!,
        chainGeneration: t.chainGeneration,
        sourceCount: p[6]!,
        sourcesDigest: sd,
        inputCount: p[8]!,
        operationDigest: (p[9]! << 128n) | p[10]!,
        inputDigest: p[11]!,
    });
    if (binding !== p[12]) throw new Error("Proof binding mismatch");
}

export function proofSidecarToWire(sidecar: ProofSidecar): ProofSidecar {
    const b = sidecar.proofBundle;
    if (
        b.format !== "invisi-provenance-proof-v1" ||
        b.target !== "evm" ||
        !/^provenance_k[1-9][0-9]*$/.test(b.circuitId) ||
        !/^([0-9a-f]{64})$/.test(b.manifestSha256) ||
        b.publicInputs.length !== 13 ||
        !/^0x(?:[0-9a-fA-F]{2})+$/.test(b.proof) ||
        b.proof.length > 131074
    )
        throw new Error("Invalid public proof sidecar");
    return {
        operationIndex: uint(sidecar.operationIndex, 32).toString(),
        proofBundle: {
            format: b.format,
            target: b.target,
            circuitId: b.circuitId,
            manifestSha256: b.manifestSha256,
            publicInputs: b.publicInputs.map((v) => word(field(v))),
            proof: b.proof,
            rootCertificates: b.rootCertificates.map(certificateToWire),
        },
    };
}

export {
    rotationPayload,
    rotationMessage,
    rotationHash,
    verifyRotationChain,
    withRotationHistory,
} from "./rotation";
export type { RotationRecord, KeyValidity, TrustedKeyring } from "./rotation";

export * from "./recovery";

export * from "./tracking";
