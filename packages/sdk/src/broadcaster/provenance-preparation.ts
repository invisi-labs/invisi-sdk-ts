import {
    CAPACITIES,
    exportSidecar,
    noteOpening,
    operationDigest,
    preflightTracking,
    word,
    assertCertificateTrust,
    validateProofBundle,
    inputDigest,
    type ManifestIdentity,
    type OfflineProver,
    type ProofSidecar,
    type ProvenanceClient,
    type RootCertificate,
    type Tracking,
    type WitnessInput,
} from "@invisi-labs/core/provenance";
import type {
    OperationPlan,
    TransactionRuntime,
    SavedOperation,
} from "../transactions/operation-types";
import { statement } from "../transactions/signing/statement";
import { exportBroadcasterIntent } from "./intent";
import { broadcasterRequestHash, type BroadcasterClient } from "./index";

export interface PreparedProvenanceCapability {
    client: ProvenanceClient;
    manifest: ManifestIdentity;
    prover: OfflineProver;
    maxRootPages?: number;
    maxLeaves?: number;
}
export interface PreparedProvenanceState {
    operationDigest: string;
    sidecars: ProofSidecar[];
    tracking: Tracking;
}
export function requirePreparedProvenance(
    plan: OperationPlan,
    client: BroadcasterClient,
    runtime?: TransactionRuntime
) {
    if (!client.configuration.provenancePolicyId || !plan.inputs.length) return;
    const cap = runtime?.options.provenance;
    if (!cap) throw Error("Provenance capability required for private inputs");
    const trust = cap.client.trust;
    if (
        BigInt(trust.chainId) !== plan.context.chainId ||
        BigInt(trust.protocolAddress) !== BigInt(plan.context.protocolAddress) ||
        word(trust.policyId) !== word(client.configuration.provenancePolicyId) ||
        cap.manifest.sha256 !== trust.manifestSha256
    )
        throw Error("Provenance deployment, policy or manifest mismatch");
}
export async function prepareProvenance(
    plan: OperationPlan,
    client: BroadcasterClient,
    runtime?: TransactionRuntime
): Promise<PreparedProvenanceState | undefined> {
    requirePreparedProvenance(plan, client, runtime);
    if (!client.configuration.provenancePolicyId || !plan.inputs.length) return;
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
    const evaluation = await source.evaluateTransaction(exportBroadcasterIntent(plan).data, [
        sidecar,
    ]);
    return {
        operationDigest: digest,
        sidecars: [sidecar],
        tracking: preflightTracking(evaluation, "0", digest),
    };
}
export async function validatePreparedBroadcast(
    saved: SavedOperation,
    client: BroadcasterClient,
    runtime: TransactionRuntime
) {
    if (!saved.broadcasterQuote || !saved.broadcasterBinding || !saved.call)
        throw Error("Prepared broadcaster quote and ready call required");
    if (
        JSON.stringify(saved.broadcasterBinding.configuration) !==
            JSON.stringify(client.configuration) ||
        saved.broadcasterBinding.intentHash !== broadcasterRequestHash(saved.call.data)
    )
        throw Error("Prepared broadcaster context changed");
    requirePreparedProvenance(saved.plan, client, runtime);
    if (client.configuration.provenancePolicyId && saved.plan.inputs.length) {
        const source = saved.provenance;
        if (!source || source.sidecars.length !== 1)
            throw Error("Prepared Provenance evidence required");
        const digest = operationDigest({
            ...saved.plan.context,
            mainCircuitCapacity: saved.plan.capacity!,
            publicInputs: statement(saved.plan).expectedPublicInputs,
        });
        if (source.operationDigest !== digest || source.tracking.operationDigest !== digest)
            throw Error("Prepared Provenance statement changed");
        const sidecar = source.sidecars[0]!;
        const pi = sidecar.proofBundle.publicInputs;
        if (
            sidecar.operationIndex !== "0" ||
            word((BigInt(pi[9]!) << 128n) | BigInt(pi[10]!)) !== digest ||
            BigInt(pi[2]!) !== BigInt(saved.plan.context.tokenAddress) ||
            BigInt(pi[8]!) !== BigInt(saved.plan.inputs.length) ||
            BigInt(pi[11]!) !== (await inputDigest(saved.plan.params!.nullifiers))
        )
            throw Error("Prepared Provenance evidence binding mismatch");
        await validateProofBundle(sidecar.proofBundle, runtime.options.provenance!.client.trust);
    } else if (saved.provenance) throw Error("Unexpected Prepared Provenance evidence");
}
