import { OfficialProvenanceClients } from "@invisi-labs/rpc/provenance";
import { validateProvenanceProof, type ProvenanceProof } from "../provenance/proof-record";
import {
    CAPACITIES,
    noteOpening,
    operationDigest,
    word,
    assertCertificateTrust,
    validateProofBundle,
    inputDigest,
    type ManifestIdentity,
    type ProofSidecar,
    type RootCertificate,
} from "@invisi-labs/protocol/provenance";
import {
    exportSidecar,
    type OfflineProver,
    type WitnessInput,
} from "@invisi-labs/prover/provenance-witness";
import { type ProvenanceClient } from "@invisi-labs/rpc/provenance";
import type {
    OperationPlan,
    TransactionRuntime,
    SavedOperation,
} from "../transactions/operation-types";
import { statement } from "../transactions/signing/statement";
import { broadcasterRequestHash, type BroadcasterClient } from "./index";
import { exportBroadcasterSubmission, publicOperationData } from "./submission";

export interface PreparedProvenanceCapability {
    client: ProvenanceClient;
    manifest: ManifestIdentity;
    prover: OfflineProver;
    maxRootPages?: number;
    maxLeaves?: number;
}
function requireProvenanceCapability(plan: OperationPlan, runtime: TransactionRuntime) {
    const cap = runtime.options.provenance;
    if (!cap) throw Error("Provenance capability required for private inputs");
    const trust = cap.client.trust;
    if (
        BigInt(trust.chainId) !== plan.context.chainId ||
        BigInt(trust.protocolAddress) !== BigInt(plan.context.protocolAddress) ||
        cap.manifest.sha256 !== trust.manifestSha256
    )
        throw Error("Provenance deployment or manifest mismatch");
}
export async function prepareProvenance(
    plan: OperationPlan,
    runtime: TransactionRuntime
): Promise<{ operationDigest: string; sidecars: ProofSidecar[] }> {
    requireProvenanceCapability(plan, runtime);
    if (!plan.inputs.length) throw Error("No private Note inputs require a Provenance proof");
    const {
        client: source,
        manifest,
        prover,
        maxRootPages = 10,
        maxLeaves = 100000,
    } = runtime!.options.provenance!;
    if (
        !Number.isSafeInteger(maxRootPages) ||
        maxRootPages < 1 ||
        maxRootPages > 100 ||
        !Number.isSafeInteger(maxLeaves) ||
        maxLeaves < 1
    )
        throw Error("Invalid Provenance replay budget");
    if (!plan.params || !plan.capacity || plan.params.nullifiers.length !== plan.inputs.length)
        throw Error("Private transact statement required");
    const trust = source.trust;
    const openings = await Promise.all(
        plan.inputs.map(async (input, i) => {
            const opening = {
                owner: input.note.ownerAddress,
                nonce: input.note.nonce,
                amount: input.note.amount,
            };
            const computed = await noteOpening({ ...plan.context, ...opening });
            if (
                computed.commitment !== BigInt(input.commitment) ||
                computed.nullifier !== BigInt(plan.params!.nullifiers[i]!)
            )
                throw Error("Prepared Note opening or nullifier mismatch");
            return opening;
        })
    );
    const digest = operationDigest({
        ...plan.context,
        mainCircuitCapacity: plan.capacity,
        publicInputs: statement(plan).expectedPublicInputs,
    });
    const status = await source.getStatus();
    const rootId = `${BigInt(trust.chainGeneration)}:${BigInt(String(status.checkpointSequence))}`;
    const latest = await source.getRoot(rootId);
    if (!latest.certificate || latest.allowedForNewProof !== true)
        throw Error("No current recognized root");
    const certificates = new Map<string, RootCertificate>();
    const matches = new Map<
        number,
        { certificate: RootCertificate; membership: { leafIndex: number; path: bigint[] } }
    >();
    let remaining = maxLeaves;
    const replay = async (certificate: RootCertificate) => {
        assertCertificateTrust(certificate, trust);
        const block = await runtime!.reader.getBlock(BigInt(certificate.confirmedBlockNumber));
        if (
            !block ||
            block.hash.toLowerCase() !== word(certificate.confirmedBlockHash).toLowerCase() ||
            (await runtime!.reader.getChainId()) !== plan.context.chainId
        )
            throw Error("Provenance checkpoint canonical anchor mismatch");
        const count = Number(BigInt(certificate.leafCount));
        if (!Number.isSafeInteger(count) || count > remaining)
            throw Error("Provenance replay leaf budget exceeded");
        remaining -= count;
        const tree = await source.syncRecognizedTree(
            `${certificate.chainGeneration}:${certificate.rootSequence}`,
            certificate,
            { maxLeaves: Math.max(1, count) }
        );
        certificates.set(String(certificate.treeId), certificate);
        for (let i = 0; i < plan.inputs.length; i++) {
            if (matches.has(i)) continue;
            const membership = await tree.membershipForCommitment(
                trust,
                plan.inputs[i]!.commitment
            );
            if (membership) matches.set(i, { certificate, membership });
        }
    };
    await replay(latest.certificate as RootCertificate);
    if (matches.size !== plan.inputs.length) {
        const newest = new Map<string, RootCertificate>();
        let cursor: string | undefined,
            complete = false;
        for (let page = 0; page < maxRootPages; page++) {
            const result = await source.getRoots(
                cursor ? { cursor, limit: 200 } : { after: "0", limit: 200 }
            );
            for (const certificate of result.items as RootCertificate[]) {
                const previous = newest.get(String(certificate.treeId));
                if (!previous || BigInt(previous.rootSequence) < BigInt(certificate.rootSequence))
                    newest.set(String(certificate.treeId), certificate);
            }
            if (!result.nextCursor) {
                complete = true;
                break;
            }
            const next = String(result.nextCursor);
            if (next === cursor) throw Error("Provenance root cursor did not advance");
            cursor = next;
        }
        if (!complete) throw Error("Provenance root replay page budget exceeded");
        for (const certificate of newest.values()) {
            if (certificates.has(String(certificate.treeId))) continue;
            const current = await source.getRoot(
                `${certificate.chainGeneration}:${certificate.rootSequence}`
            );
            if (current.allowedForNewProof !== true) continue;
            await replay(certificate);
            if (matches.size === plan.inputs.length) break;
        }
    }
    if (matches.size !== plan.inputs.length) throw Error("Prepared Note is not recognized");
    const used = [
        ...new Map(
            [...matches.values()].map((m) => [String(m.certificate.treeId), m.certificate])
        ).values(),
    ].sort((a, b) => (BigInt(a.treeId) < BigInt(b.treeId) ? -1 : 1));
    const inputs: WitnessInput[] = openings.map((opening, i) => {
        const match = matches.get(i)!;
        return {
            ...opening,
            sourceIndex: used.findIndex(
                (c) => BigInt(c.treeId) === BigInt(match.certificate.treeId)
            ),
            leafIndex: match.membership.leafIndex,
            path: match.membership.path,
        };
    });
    const capacity = CAPACITIES.find((k) => k >= inputs.length);
    if (!capacity) throw Error("Provenance input capacity exceeded");
    const sidecar = await exportSidecar(
        {
            ...trust,
            capacity,
            tokenAddress: plan.context.tokenAddress,
            operationDigest: digest,
            inputs,
            sources: used.map((c) => ({ treeId: c.treeId, root: c.root, leafCount: c.leafCount })),
        },
        used,
        trust,
        manifest,
        prover,
        0
    );
    return { operationDigest: digest, sidecars: [sidecar] };
}
export async function provePreparedProvenance(
    saved: SavedOperation,
    runtime: TransactionRuntime,
    capability?: PreparedProvenanceCapability,
    reprove = false
): Promise<ProvenanceProof> {
    if (!saved.proof || saved.plan.kind !== "transfer" || !saved.plan.inputs.length)
        throw Error("Ready transaction with private Note inputs required");
    const data = publicOperationData(saved);
    if (saved.provenance && saved.provenance.data !== data)
        throw Error("Prepared Provenance operation bytes changed");
    const provider = runtime.options.prover as typeof runtime.options.prover &
        Partial<import("@invisi-labs/prover/provenance-witness").ProvenanceProvider>;
    const active =
        capability ??
        runtime.options.provenance ??
        (provider?.getProvenanceCapability
            ? {
                  ...(await provider.getProvenanceCapability()),
                  client:
                      runtime.options.provenanceClient ??
                      (await officialProvenance.get(saved.plan.context)),
              }
            : undefined);
    if (!active) throw Error("Local Provenance capability required");
    if (saved.provenance && !reprove)
        return validateProvenanceProof(structuredClone(saved.provenance), active.client.trust);
    const localRuntime = { ...runtime, options: { ...runtime.options, provenance: active } };
    const evidence = await prepareProvenance(saved.plan, localRuntime);
    const packet: ProvenanceProof = {
        format: "invisi-provenance-submission-v1",
        data,
        context: {
            chainId: saved.plan.context.chainId.toString(),
            protocolAddress: saved.plan.context.protocolAddress,
            tokenAddress: saved.plan.context.tokenAddress,
        },
        mainCircuitCapacity: saved.plan.capacity!,
        publicInputs: [...statement(saved.plan).expectedPublicInputs],
        ...evidence,
    };
    return validateProvenanceProof(packet, active.client.trust);
}
export function validateBroadcastEnvelope(saved: SavedOperation, client: BroadcasterClient) {
    if (!saved.broadcasterQuote || !saved.broadcasterBinding)
        throw Error("Prepared broadcaster quote and ready call required");
    const submission = exportBroadcasterSubmission(saved);
    if (
        JSON.stringify(saved.broadcasterBinding.configuration) !==
            JSON.stringify(client.configuration) ||
        saved.broadcasterBinding.intentHash !== broadcasterRequestHash(submission.data)
    )
        throw Error("Prepared broadcaster context changed");
    const context = saved.plan.context;
    if (
        (saved.call &&
            (BigInt(saved.call.to) !== BigInt(context.protocolAddress) ||
                saved.call.value !== 0n)) ||
        saved.broadcasterQuote.context?.chainId !== context.chainId ||
        BigInt(saved.broadcasterQuote.context.protocol) !== BigInt(context.protocolAddress)
    )
        throw Error("Prepared broadcaster deployment changed");
}
export async function validatePreparedBroadcast(
    saved: SavedOperation,
    client: BroadcasterClient,
    runtime: TransactionRuntime
) {
    validateBroadcastEnvelope(saved, client);
    if (saved.broadcasterQuote!.provenanceRequired && saved.plan.inputs.length) {
        const source = saved.provenance;
        if (!source || source.sidecars.length !== 1)
            throw Error("Prepared Provenance evidence required");
        const digest = operationDigest({
            ...saved.plan.context,
            mainCircuitCapacity: saved.plan.capacity!,
            publicInputs: statement(saved.plan).expectedPublicInputs,
        });
        if (source.operationDigest !== digest || source.data !== publicOperationData(saved))
            throw Error("Prepared Provenance statement changed");
        const sidecar = source.sidecars[0]!;
        const pi = sidecar.proofBundle.publicInputs;
        if (
            sidecar.operationIndex !== "0" ||
            word((BigInt(pi[7]!) << 128n) | BigInt(pi[8]!)) !== digest ||
            BigInt(pi[2]!) !== BigInt(saved.plan.context.tokenAddress) ||
            BigInt(pi[6]!) !== BigInt(saved.plan.inputs.length) ||
            BigInt(pi[9]!) !== (await inputDigest(saved.plan.params!.nullifiers))
        )
            throw Error("Prepared Provenance evidence binding mismatch");
        if (runtime.options.provenance)
            await validateProofBundle(sidecar.proofBundle, runtime.options.provenance.client.trust);
    } else if (saved.provenance) throw Error("Unexpected Prepared Provenance evidence");
}

const officialProvenance = new OfficialProvenanceClients();
