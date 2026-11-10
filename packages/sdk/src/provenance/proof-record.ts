import {
    inputDigest,
    operationDigest,
    proofSidecarToWire,
    validateProofBundle,
    word,
    type ProofSidecar,
    type TrustContext,
} from "@invisi-labs/core/provenance";
import { normalizeTransactRequest, transactUserPublicInputs } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { decodeBroadcasterIntent } from "../broadcaster/index";

/** Public recovery packet; persist encrypted Note openings separately if reproof is needed. */
export interface ProvenanceProof {
    format: "invisi-provenance-submission-v1";
    data: string;
    context: { chainId: string; protocolAddress: string; tokenAddress: string };
    mainCircuitCapacity: number;
    publicInputs: string[];
    operationDigest: string;
    sidecars: ProofSidecar[];
}

function keys(value: object, allowed: string[]) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !allowed.includes(key))
    )
        throw Error("Unknown Provenance packet field");
}

export async function validateProvenanceProof(
    packet: ProvenanceProof,
    trust: TrustContext
): Promise<ProvenanceProof> {
    keys(packet, [
        "format",
        "data",
        "context",
        "mainCircuitCapacity",
        "publicInputs",
        "operationDigest",
        "sidecars",
    ]);
    keys(packet.context, ["chainId", "protocolAddress", "tokenAddress"]);
    if (
        packet.format !== "invisi-provenance-submission-v1" ||
        typeof packet.context.chainId !== "string" ||
        typeof packet.context.protocolAddress !== "string" ||
        typeof packet.context.tokenAddress !== "string" ||
        BigInt(packet.context.chainId) !== BigInt(trust.chainId) ||
        BigInt(packet.context.protocolAddress) !== BigInt(trust.protocolAddress) ||
        !Array.isArray(packet.sidecars) ||
        packet.sidecars.length !== 1
    )
        throw Error("Provenance packet deployment or shape mismatch");
    const decoded = decodeBroadcasterIntent(packet.data);
    if (decoded.method !== "transact") throw Error("Provenance requires private transact calldata");
    const context = {
        chainId: BigInt(packet.context.chainId),
        protocolAddress: packet.context.protocolAddress as Hex,
        tokenAddress: packet.context.tokenAddress as Hex,
    };
    const raw = decoded.request.params;
    const params = {
        token: raw.token,
        sources: Array.from(raw.sources, (source: any) => ({
            treeId: source.treeId,
            merkleRoot: source.merkleRoot,
        })),
        nullifiers: [...raw.nullifiers],
        noteCommitments: [...raw.noteCommitments],
        withdrawalAddress: raw.withdrawalAddress,
        withdrawalAmount: raw.withdrawalAmount,
        deadline: raw.deadline,
        feeRecipient: raw.feeRecipient,
        feeAmount: raw.feeAmount,
    };
    const deliveries = decoded.request.deliveries.map((d: { toObject(deep: boolean): unknown }) =>
        d.toObject(true)
    );
    const funding = decoded.request.funding.toObject(true);
    funding.permit.v = Number(funding.permit.v);
    const normalized = normalizeTransactRequest(context, params, deliveries, funding);
    const publicInputs = transactUserPublicInputs(context, params, deliveries, funding);
    if (
        !normalized.inputCount ||
        normalized.capacity !== packet.mainCircuitCapacity ||
        JSON.stringify(publicInputs) !== JSON.stringify(packet.publicInputs)
    )
        throw Error("Provenance native statement mismatch");
    const digest = operationDigest({
        ...context,
        mainCircuitCapacity: normalized.capacity,
        publicInputs,
    });
    if (packet.operationDigest !== digest) throw Error("Provenance operation digest mismatch");
    const sidecar = packet.sidecars[0]!;
    const wire = proofSidecarToWire(sidecar);
    if (wire.operationIndex !== "0") throw Error("Unsupported Provenance operation index");
    await validateProofBundle(wire.proofBundle, trust);
    const pi = wire.proofBundle.publicInputs.map(BigInt);
    if (
        pi[2] !== BigInt(context.tokenAddress) ||
        pi[6] !== BigInt(normalized.inputCount) ||
        word((pi[7]! << 128n) | pi[8]!) !== digest ||
        pi[9] !== (await inputDigest(normalized.nullifiers))
    )
        throw Error("Provenance proof statement mismatch");
    return {
        ...packet,
        context: { ...packet.context },
        publicInputs: [...publicInputs],
        sidecars: [wire],
    };
}
