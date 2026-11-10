import { sha256 } from "@noble/hashes/sha256";
import { ed25519 } from "@noble/curves/ed25519";
import { AbiCoder, keccak256, getBytes, hexlify, concat } from "ethers";
import { poseidonHash } from "@invisi-labs/primitives";
export const DEFAULT_PROVENANCE_ENDPOINT = "https://provenance.invisipay.fi";

export type Integer = bigint | string | number;
export const FIELD_MODULUS =
    21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const CAPACITIES: readonly number[] = Object.freeze([10, 20, 40, 80, 120, 160, 190]);
export const PUBLIC_INPUTS = Object.freeze([
    "chain_id",
    "protocol_address",
    "token_address",
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
}
export async function scopeHash(s: Scope): Promise<bigint> {
    const protocol = uint(s.protocolAddress, 160);
    if (!protocol) throw new Error("Zero protocol");
    return hash([DOMAINS.SCOPE, uint(s.chainId, 64), protocol]);
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
export interface TrustContext extends Scope {
    chainGeneration: Integer;
    providerId: Integer;
    signingKeys: Readonly<Record<string, Uint8Array>>;
    manifestSha256: string;
    signingKeyValidity?: Readonly<Record<string, { activatedAt: string; retiredAt?: string }>>;
}
export function assertCertificateTrust(c: RootCertificate, trust: TrustContext): void {
    if (Object.keys(c).some((k) => k !== "signature" && !CERT_LAYOUT.some(([name]) => name === k)))
        throw Error("Unknown root certificate field");
    for (const k of ["chainId", "protocolAddress", "chainGeneration", "providerId"] as const)
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
export type PublicResult = Record<string, unknown> & { scope: Scope };
export function certificateToWire(c: RootCertificate): RootCertificate {
    if (Object.keys(c).some((k) => k !== "signature" && !CERT_LAYOUT.some(([name]) => name === k)))
        throw Error("Unknown root certificate field");
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
    if (!CAPACITIES.includes(capacity) || b.publicInputs.length !== 11)
        throw new Error("Unsupported provenance circuit or ABI");
    const p = b.publicInputs.map((v) => {
        if (!/^0x[0-9a-fA-F]{64}$/.test(v))
            throw new Error("Public inputs must be canonical words");
        return field(v);
    });
    uint(p[7]!, 128);
    uint(p[8]!, 128);
    if (
        p[0] !== BigInt(t.chainId) ||
        p[1] !== BigInt(t.protocolAddress) ||
        p[3] !== BigInt(t.chainGeneration) ||
        p[4] !== BigInt(b.rootCertificates.length) ||
        p[6]! < 1n ||
        p[6]! > BigInt(capacity) ||
        p[4]! < 1n ||
        p[4]! > p[6]!
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
    if (sd !== p[5]) throw new Error("Proof sources digest mismatch");
    const binding = await bindingDigest({
        scope: await scopeHash(t),
        tokenAddress: p[2]!,
        chainGeneration: t.chainGeneration,
        sourceCount: p[4]!,
        sourcesDigest: sd,
        inputCount: p[6]!,
        operationDigest: (p[7]! << 128n) | p[8]!,
        inputDigest: p[9]!,
    });
    if (binding !== p[10]) throw new Error("Proof binding mismatch");
}

export function proofSidecarToWire(sidecar: ProofSidecar): ProofSidecar {
    if (Object.keys(sidecar).some((k) => !["operationIndex", "proofBundle"].includes(k)))
        throw Error("Unknown proof sidecar field");
    if (
        Object.keys(sidecar.proofBundle).some(
            (k) =>
                ![
                    "format",
                    "circuitId",
                    "manifestSha256",
                    "target",
                    "publicInputs",
                    "proof",
                    "rootCertificates",
                ].includes(k)
        )
    )
        throw Error("Unknown proof bundle field");
    const b = sidecar.proofBundle;
    if (
        b.format !== "invisi-provenance-proof-v1" ||
        b.target !== "evm" ||
        !/^provenance_k[1-9][0-9]*$/.test(b.circuitId) ||
        !/^([0-9a-f]{64})$/.test(b.manifestSha256) ||
        b.publicInputs.length !== 11 ||
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

export * from "./rotation";
export * from "./tracking";
export * from "./release";
export * from "./tree";
export { provenanceIntentHash } from "@invisi-labs/primitives";
