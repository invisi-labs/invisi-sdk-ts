import {
    RecognizedTree,
    proofSidecarToWire,
    type Integer,
    type ProofBundle,
} from "@invisi-labs/protocol/provenance";
import { poseidonHash } from "@invisi-labs/primitives";
const hash = async (v: Integer[]) => BigInt(await poseidonHash(v.map(field)));
import {
    scopeHash,
    recognizedLeaf,
    checkpointHash,
    rootCertificatePayload,
} from "@invisi-labs/protocol/provenance";
import { validateTracking, type TrackingResult } from "@invisi-labs/protocol/provenance";
import {
    uint,
    word,
    field,
    assertCertificateTrust,
    certificateToWire,
    validateProofBundle,
    DEFAULT_PROVENANCE_ENDPOINT,
    type Scope,
    type TrustContext,
    type PublicResult,
    type ProofSidecar,
    type RootCertificate,
} from "@invisi-labs/protocol/provenance";
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
                redirect: "error",
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
        if (Object.keys(result.scope).some((k) => !["chainId", "protocolAddress"].includes(k)))
            throw Error("Unknown deployment scope field");
        if (
            [
                "provenance_evaluateTransaction",
                "provenance_submitSourceProof",
                "provenance_submitProof",
                "provenance_getProofJob",
                "provenance_getTracking",
            ].includes(method) &&
            ["chainGeneration", "providerId", "signingKeyId", "manifestSha256"].some(
                (k) => result[k] === undefined
            )
        )
            throw new Error("Missing response trust identity");
        for (const k of ["chainId", "protocolAddress"] as const)
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
            if (method !== "provenance_getRules" && !this.trust.signingKeys[id])
                throw new Error("Untrusted signing key");
        }
        return result;
    }
    getVersion(signal?: AbortSignal): Promise<PublicResult> {
        return this.call("provenance_getVersion", {}, signal);
    }
    getStatus(signal?: AbortSignal): Promise<PublicResult> {
        return this.call("provenance_getStatus", {}, signal);
    }
    getRules(): Promise<PublicResult> {
        return this.call("provenance_getRules", {});
    }
    async getRoots(query: Record<string, unknown> = {}): Promise<PublicResult> {
        const r = await this.call("provenance_getRoots", {
            ...query,
        });
        if (!Array.isArray(r.items)) throw new Error("Missing root certificates");
        for (const c of r.items) assertCertificateTrust(c as RootCertificate, this.trust);
        return r;
    }
    async getRoot(rootId: string): Promise<PublicResult> {
        const r = await this.call<PublicResult>("provenance_getRoot", {
            rootId,
        });
        if (r.certificate) assertCertificateTrust(r.certificate as RootCertificate, this.trust);
        return r;
    }
    getLeaves(rootId: string, fromIndex: string, limit = 50): Promise<PublicResult> {
        if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Page limit");
        return this.call("provenance_getLeaves", {
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
                for (const k of ["chainId", "protocolAddress"] as const)
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
            commitment: word(field(commitment)),
        });
    }
    getOperationRecognition(locator: Record<string, string>): Promise<PublicResult> {
        return this.call("provenance_getOperationRecognition", {
            ...locator,
        });
    }
    getTransactionRecognition(txHash: string): Promise<PublicResult> {
        return this.call("provenance_getTransactionRecognition", {
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
            data,
            proofSidecars: proofSidecars.map(proofSidecarToWire),
        });
    }
    async submitSourceProof(
        data: string,
        proofSidecars: readonly ProofSidecar[]
    ): Promise<PublicResult> {
        assertPublicSubmission({ data, proofSidecars });
        for (const sidecar of proofSidecars) {
            uint(sidecar.operationIndex, 32);
            await validateProofBundle(sidecar.proofBundle, this.trust);
        }
        return this.call("provenance_submitSourceProof", {
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
            proofBundle: proofSidecarToWire({ operationIndex: "0", proofBundle }).proofBundle,
            idempotencyKey,
        });
    }
    async getTracking(trackingId: string, signal?: AbortSignal): Promise<TrackingResult> {
        if (!/^[a-f0-9]{48}$/.test(trackingId)) throw Error("Invalid tracking id");
        const result = await this.call("provenance_getTracking", { trackingId }, signal);
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

export { OfficialProvenanceClients, officialProvenanceClient } from "./official-clients";
