import {
    preflightTracking,
    validateTracking,
    TrackingStaleGenerationError,
    type TrackingResult,
} from "@invisi-labs/protocol/provenance";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { keccak256 } from "ethers";
import {
    validateProofBundle,
    inputDigest,
    word,
    uint,
    type ProofSidecar,
    type TrustContext,
    type Scope,
    type RecognizedTree,
} from "@invisi-labs/protocol/provenance";
export interface AtomicRecoveryRecords {
    read(key: string): Promise<{ revision: number; data: Uint8Array } | undefined>;
    compareAndSwap(
        key: string,
        previousRevision: number,
        next: { revision: number; data: Uint8Array }
    ): Promise<boolean>;
}
export interface RecoveryAtomicStore {
    load(id: string): Promise<RecoveryRecord | undefined>;
    compareAndSwap(id: string, revision: number, next: RecoveryRecord): Promise<boolean>;
}
export interface FrozenProvenanceIntent extends Scope {
    tokenAddress: string;
    operationIndex: string;
    operationDigest: string;
    inputNullifiers: string[];
    calldata: string;
    calldataHash: string;
    signedRequestHash: string;
}
export type RecoveryState =
    | "broadcast_possible"
    | "broadcast"
    | "pending"
    | "needs_reproof"
    | "tracking_expired"
    | "tracking_superseded"
    | "proof_rejected"
    | "pending_source"
    | "source_rejected"
    | "recognized";
export interface RecoveryRecord {
    format: "invisi-provenance-recovery-v1";
    deliveryMode: "tracked" | "direct";
    trackingId?: string;
    revision: number;
    id: string;
    intent: FrozenProvenanceIntent;
    manifestSha256: string;
    chainGeneration: string;
    sidecar: ProofSidecar;
    idempotencyKey: string;
    state: RecoveryState;
    transactionHash?: string;
    locator?: Record<string, string>;
    jobId?: string;
    proofValid?: boolean;
    proofJobStatus?: string;
    sourceState?: string;
    reasonCode?: string;
    checkpointSequence?: string;
}
function onlyKeys(value: unknown, keys: string[]) {
    if (value && typeof value === "object" && Object.keys(value).some((k) => !keys.includes(k)))
        throw Error("Unknown recovery field; private material is host-only");
}
function publicShape(record: RecoveryRecord) {
    onlyKeys(record, [
        "format",
        "deliveryMode",
        "trackingId",
        "revision",
        "id",
        "intent",
        "manifestSha256",
        "chainGeneration",
        "sidecar",
        "idempotencyKey",
        "state",
        "transactionHash",
        "locator",
        "jobId",
        "proofValid",
        "proofJobStatus",
        "sourceState",
        "reasonCode",
        "checkpointSequence",
    ]);
    onlyKeys(record.intent, [
        "chainId",
        "protocolAddress",
        "tokenAddress",
        "operationDigest",
        "operationIndex",
        "inputNullifiers",
        "calldata",
        "calldataHash",
        "signedRequestHash",
    ]);
    onlyKeys(record.locator, ["blockHash", "txHash", "operationIndex"]);
    onlyKeys(record.sidecar, ["operationIndex", "proofBundle"]);
    if (record.sidecar) {
        const b = record.sidecar.proofBundle;
        onlyKeys(b, [
            "format",
            "circuitId",
            "manifestSha256",
            "target",
            "publicInputs",
            "proof",
            "rootCertificates",
        ]);
        for (const c of b.rootCertificates ?? [])
            onlyKeys(c, [
                "certificateVersion",
                "providerId",
                "signingKeyId",
                "chainId",
                "protocolAddress",
                "chainGeneration",
                "rootSequence",
                "treeId",
                "leafCount",
                "root",
                "confirmedBlockNumber",
                "confirmedBlockHash",
                "decisionLogHash",
                "previousCheckpointHash",
                "issuedAt",
                "signature",
            ]);
    }
}
function publicJSON(value: unknown): string {
    return JSON.stringify(value, (key, v: unknown) => {
        if (/^(opening|owners?|nonce|nonces|amounts?|witness|paths|privateKey|secret)$/i.test(key))
            throw Error("Private recovery material is host-only");
        if (typeof v === "bigint") throw Error("Recovery records require public string encoding");
        return v;
    });
}
function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object")
        return Object.fromEntries(
            Object.entries(value)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => [k, canonical(v)])
        );
    return value;
}
export function recoverySubmissionKey(base: string, sidecar: ProofSidecar): string {
    if (base.startsWith("internal/")) throw Error("reserved idempotency key prefix");
    if (!/^[\x21-\x7e]{1,63}$/.test(base)) throw Error("Invalid recovery idempotency key");
    return (
        base +
        ":" +
        bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(canonical(sidecar.proofBundle)))))
    );
}
/** Ciphertext adapters are structurally compatible with the session AtomicRecordStore. */
export class EncryptedRecoveryStore implements RecoveryAtomicStore {
    private constructor(
        private readonly records: AtomicRecoveryRecords,
        private readonly key: Parameters<typeof crypto.subtle.encrypt>[1]
    ) {}
    static fromKey(
        records: AtomicRecoveryRecords,
        key: Parameters<typeof crypto.subtle.encrypt>[1]
    ): EncryptedRecoveryStore {
        if (
            key.type !== "secret" ||
            key.algorithm.name !== "AES-GCM" ||
            !("length" in key.algorithm) ||
            key.algorithm.length !== 256 ||
            !key.usages.includes("encrypt") ||
            !key.usages.includes("decrypt")
        )
            throw Error("Recovery key must support AES-256-GCM");
        return new EncryptedRecoveryStore(records, key);
    }
    static async fromBytes(
        records: AtomicRecoveryRecords,
        key: Uint8Array
    ): Promise<EncryptedRecoveryStore> {
        if (key.length !== 32) throw Error("Recovery encryption requires 32 key bytes");
        const copy = Uint8Array.from(key);
        try {
            return EncryptedRecoveryStore.fromKey(
                records,
                await crypto.subtle.importKey("raw", copy, { name: "AES-GCM" }, false, [
                    "encrypt",
                    "decrypt",
                ])
            );
        } finally {
            copy.fill(0);
        }
    }
    private storageKey(id: string) {
        if (!id || new TextEncoder().encode(id).length > 256) throw Error("Invalid recovery id");
        return `Invisi.Provenance.Recovery.v1:${id}`;
    }
    private aad(key: string, revision: number) {
        if (!Number.isSafeInteger(revision) || revision < 1)
            throw Error("Invalid recovery revision");
        return new TextEncoder().encode(`Invisi.Provenance.RecoveryRecord.v1\0${revision}\0${key}`);
    }
    async load(id: string): Promise<RecoveryRecord | undefined> {
        const key = this.storageKey(id),
            stored = await this.records.read(key);
        if (!stored) return undefined;
        const bytes = Uint8Array.from(stored.data);
        if (bytes.length < 29 || bytes[0] !== 1) throw Error("Recovery authentication failed");
        const plain = new Uint8Array(
            await crypto.subtle.decrypt(
                {
                    name: "AES-GCM",
                    iv: bytes.slice(1, 13),
                    additionalData: this.aad(key, stored.revision),
                },
                this.key,
                bytes.slice(13)
            )
        );
        try {
            const record = JSON.parse(new TextDecoder().decode(plain)) as RecoveryRecord;
            if (record.revision !== stored.revision) throw Error("Recovery revision mismatch");
            publicShape(record);
            publicJSON(record);
            return record;
        } finally {
            plain.fill(0);
        }
    }
    async compareAndSwap(id: string, revision: number, next: RecoveryRecord): Promise<boolean> {
        publicShape(next);
        if (next.revision !== revision + 1) throw Error("Invalid next recovery revision");
        const key = this.storageKey(id),
            iv = crypto.getRandomValues(new Uint8Array(12)),
            plain = new TextEncoder().encode(publicJSON(next));
        try {
            const sealed = new Uint8Array(
                await crypto.subtle.encrypt(
                    { name: "AES-GCM", iv, additionalData: this.aad(key, next.revision) },
                    this.key,
                    plain
                )
            );
            const data = new Uint8Array(13 + sealed.length);
            data[0] = 1;
            data.set(iv, 1);
            data.set(sealed, 13);
            return this.records.compareAndSwap(key, revision, { revision: next.revision, data });
        } finally {
            plain.fill(0);
        }
    }
}
export interface RecoveryReconciliation {
    status: "unseen" | "pending" | "confirmed" | "reorged";
    calldataHash: string;
    signedRequestHash: string;
    chainGeneration: string;
    transactionHash?: string;
    locator?: Record<string, string>;
}
export interface RecoveryHost {
    /** Decode/authenticate the frozen public transaction and independently verify the local proof. */
    verifyFrozenStatement(
        intent: Readonly<FrozenProvenanceIntent>,
        sidecar: Readonly<ProofSidecar>
    ): Promise<void>;
    reconcileFrozenTransaction(record: Readonly<RecoveryRecord>): Promise<RecoveryReconciliation>;
    localReprove?(
        record: Readonly<RecoveryRecord>,
        generation: string,
        signal?: AbortSignal
    ): Promise<ProofSidecar>;
}
export interface RecoveryService {
    trust: TrustContext;
    evaluateTransaction(
        data: unknown,
        sidecars: ProofSidecar[]
    ): Promise<import("@invisi-labs/protocol/provenance").PublicResult>;
    getTracking(id: string): Promise<TrackingResult>;
    submitProof(
        locator: Record<string, string>,
        bundle: ProofSidecar["proofBundle"],
        idempotencyKey: string
    ): Promise<Record<string, unknown>>;
    getProofJob(jobId: string): Promise<Record<string, unknown>>;
    getOperationRecognition(locator: Record<string, string>): Promise<Record<string, unknown>>;
}
const clone = <T>(value: T): T => structuredClone(value);
function checkCancelled(signal?: AbortSignal) {
    if (signal?.aborted) throw Error("Local recovery cancelled; broadcast remains active");
}
/** No broadcast, signing, fee selection or private opening storage occurs in this coordinator. */
export class RecoveryCoordinator {
    constructor(
        private readonly store: RecoveryAtomicStore,
        private readonly service: RecoveryService,
        private readonly host: RecoveryHost
    ) {}
    private async validate(record: RecoveryRecord) {
        if (
            record.format !== "invisi-provenance-recovery-v1" ||
            !record.id ||
            !record.idempotencyKey ||
            record.idempotencyKey.length > 63
        )
            throw Error("Invalid recovery record");
        if (
            !["tracked", "direct"].includes(record.deliveryMode) ||
            (record.trackingId !== undefined && !/^[a-f0-9]{48}$/.test(record.trackingId)) ||
            (record.revision > 0 &&
                record.deliveryMode === "tracked" &&
                !record.trackingId &&
                record.state !== "needs_reproof")
        )
            throw Error("Recovery tracking mode/identity missing");
        recoverySubmissionKey(record.idempotencyKey, record.sidecar);
        publicShape(record);
        publicJSON(record);
        for (const key of [
            "chainId",
            "protocolAddress",
            "tokenAddress",
            "operationDigest",
            "operationIndex",
        ] as const)
            uint(
                record.intent[key],
                key === "chainId"
                    ? 64
                    : key === "operationIndex"
                      ? 32
                      : ["protocolAddress", "tokenAddress"].includes(key)
                        ? 160
                        : 256
            );

        const intent = record.intent,
            t = this.service.trust;
        for (const key of ["chainId", "protocolAddress"] as const)
            if (BigInt(intent[key]) !== BigInt(t[key])) throw Error("Recovery scope mismatch");
        if (
            record.manifestSha256 !== t.manifestSha256 ||
            keccak256(intent.calldata) !== intent.calldataHash ||
            word(intent.signedRequestHash) !== intent.signedRequestHash
        )
            throw Error("Frozen recovery intent mismatch");
        if (BigInt(record.sidecar.operationIndex) !== BigInt(intent.operationIndex))
            throw Error("Recovery operation index mismatch");
        const p = record.sidecar.proofBundle.publicInputs;
        if (
            p.length !== 11 ||
            BigInt(p[2]!) !== BigInt(intent.tokenAddress) ||
            ((BigInt(p[7]!) << 128n) | BigInt(p[8]!)) !== BigInt(intent.operationDigest) ||
            BigInt(p[6]!) !== BigInt(intent.inputNullifiers.length)
        )
            throw Error("Recovery statement mismatch");
        const nullifiers = intent.inputNullifiers.map((v) => word(v));
        if (new Set(nullifiers).size !== nullifiers.length)
            throw Error("Duplicate recovery nullifier");
        if ((await inputDigest(intent.inputNullifiers)) !== BigInt(p[9]!))
            throw Error("Recovery nullifiers digest mismatch");
        await validateProofBundle(record.sidecar.proofBundle, {
            ...t,
            chainGeneration: record.chainGeneration,
        });
        await this.host.verifyFrozenStatement(clone(intent), clone(record.sidecar));
    }
    private async save(record: RecoveryRecord, previous: number) {
        if (!Number.isSafeInteger(previous) || previous < 0 || !Number.isSafeInteger(previous + 1))
            throw Error("Recovery revision exhausted");
        record.revision = previous + 1;
        if (!(await this.store.compareAndSwap(record.id, previous, clone(record))))
            throw Error("Recovery CAS conflict");
        return clone(record);
    }
    async prepare(
        id: string,
        intent: FrozenProvenanceIntent,
        sidecar: ProofSidecar,
        idempotencyKey: string
    ) {
        return this.prepareMode(id, intent, sidecar, idempotencyKey, "tracked");
    }
    async prepareDirect(
        id: string,
        intent: FrozenProvenanceIntent,
        sidecar: ProofSidecar,
        idempotencyKey: string
    ) {
        return this.prepareMode(id, intent, sidecar, idempotencyKey, "direct");
    }
    private async prepareMode(
        id: string,
        intent: FrozenProvenanceIntent,
        sidecar: ProofSidecar,
        idempotencyKey: string,
        deliveryMode: "tracked" | "direct"
    ): Promise<{ record: RecoveryRecord; broadcastPermit: true }> {
        const record: RecoveryRecord = {
            format: "invisi-provenance-recovery-v1",
            revision: 0,
            deliveryMode,
            id,
            intent: clone(intent),
            sidecar: clone(sidecar),
            idempotencyKey,
            state: "broadcast_possible",
            manifestSha256: this.service.trust.manifestSha256,
            chainGeneration: String(this.service.trust.chainGeneration),
        };
        await this.validate(record);
        if (await this.store.load(id)) throw Error("Recovery id already exists");
        if (deliveryMode === "tracked") {
            const evaluated = await this.service.evaluateTransaction(record.intent.calldata, [
                clone(record.sidecar),
            ]);
            record.trackingId = preflightTracking(
                evaluated,
                record.intent.operationIndex,
                record.intent.operationDigest
            ).id;
        }
        await this.save(record, 0);
        return { record: clone(record), broadcastPermit: true };
    }
    async markBroadcast(id: string, transactionHash: string): Promise<RecoveryRecord> {
        const record = await this.required(id);
        if (record.transactionHash && record.transactionHash !== word(transactionHash))
            throw Error("Frozen transaction hash mismatch");
        record.transactionHash = word(transactionHash);
        if (record.state === "broadcast_possible") record.state = "broadcast";
        return this.save(record, record.revision);
    }
    private async required(id: string) {
        const record = await this.store.load(id);
        if (!record || record.id !== id) throw Error("Missing recovery record");
        await this.validate(record);
        return record;
    }
    async resume(
        id: string,
        options: { signal?: AbortSignal; reprove?: boolean } = {}
    ): Promise<RecoveryRecord> {
        checkCancelled(options.signal);
        const record = await this.required(id),
            previous = record.revision;
        // Reconciliation precedes generation checks and every remote mutation.
        const fact = clone(await this.host.reconcileFrozenTransaction(clone(record)));
        checkCancelled(options.signal);
        if (
            fact.calldataHash !== record.intent.calldataHash ||
            fact.signedRequestHash !== record.intent.signedRequestHash ||
            (record.transactionHash && fact.transactionHash !== record.transactionHash)
        )
            throw Error("Reconciled frozen transaction mismatch");
        if (!["unseen", "pending", "confirmed", "reorged"].includes(fact.status))
            throw Error("Invalid reconciliation status");
        uint(fact.chainGeneration, 64);
        if (
            record.chainGeneration !== fact.chainGeneration ||
            fact.status === "reorged" ||
            BigInt(fact.chainGeneration) !== BigInt(this.service.trust.chainGeneration) ||
            record.state === "needs_reproof" ||
            (options.reprove === true && record.state === "proof_rejected")
        ) {
            record.state = "needs_reproof";
            delete record.trackingId;
            delete record.jobId;
            delete record.locator;
            delete record.proofValid;
            delete record.proofJobStatus;
            delete record.reasonCode;
            delete record.sourceState;
            delete record.checkpointSequence;
            if (
                options.reprove &&
                this.host.localReprove &&
                fact.status === "confirmed" &&
                BigInt(fact.chainGeneration) === BigInt(this.service.trust.chainGeneration)
            ) {
                const sidecar = await this.host.localReprove(
                    clone(record),
                    fact.chainGeneration,
                    options.signal
                );
                checkCancelled(options.signal);
                const next = {
                    ...record,
                    revision: 0,
                    sidecar: clone(sidecar),
                    chainGeneration: fact.chainGeneration,
                };
                await this.validate(next);
                if (record.deliveryMode === "tracked") {
                    const evaluated = await this.service.evaluateTransaction(next.intent.calldata, [
                        clone(next.sidecar),
                    ]);
                    record.trackingId = preflightTracking(
                        evaluated,
                        next.intent.operationIndex,
                        next.intent.operationDigest
                    ).id;
                }
                record.sidecar = next.sidecar;
                record.chainGeneration = next.chainGeneration;
                // A replacement bundle gets its own deterministic submission key without changing the frozen transaction.
                record.state = "pending";
            } else return this.save(record, previous);
        }
        if (fact.status === "confirmed") {
            if (!fact.locator || !fact.transactionHash)
                throw Error("Missing authenticated mined locator");
            if (
                word(fact.transactionHash) !== fact.transactionHash ||
                Object.keys(fact.locator).some(
                    (k) => !["blockHash", "txHash", "operationIndex"].includes(k)
                ) ||
                fact.locator.txHash !== fact.transactionHash ||
                word(fact.locator.blockHash!) !== fact.locator.blockHash ||
                BigInt(fact.locator.operationIndex!) !== BigInt(record.intent.operationIndex)
            )
                throw Error("Invalid authenticated locator");
            record.transactionHash = fact.transactionHash;
            record.locator = clone(fact.locator);
        }
        if (record.deliveryMode === "tracked") {
            if (!record.trackingId) throw Error("Recovery tracking id required");
            let result: TrackingResult;
            try {
                result = await this.service.getTracking(record.trackingId);
            } catch (error) {
                if (error instanceof TrackingStaleGenerationError) {
                    record.state = "needs_reproof";
                    return this.save(record, previous);
                }
                throw error;
            }
            const tracking = validateTracking(result.tracking, record.trackingId);
            if (tracking.operationDigest !== word(record.intent.operationDigest))
                throw Error("Tracking statement mismatch");
            delete record.reasonCode;
            if (tracking.reasonCode !== undefined) record.reasonCode = tracking.reasonCode;
            if (tracking.status === "expired" || tracking.status === "superseded") {
                record.state =
                    tracking.status === "expired" ? "tracking_expired" : "tracking_superseded";
                delete record.reasonCode;
                if (tracking.reasonCode !== undefined) record.reasonCode = tracking.reasonCode;
                return this.save(record, previous);
            }
            if (fact.status !== "confirmed" || tracking.status === "pending_confirmation") {
                record.state = "pending";
                return this.save(record, previous);
            }
            const matched = tracking.matched!;
            if (
                !fact.locator ||
                matched.txHash !== fact.transactionHash ||
                matched.blockHash !== fact.locator.blockHash ||
                matched.operationIndex !== fact.locator.operationIndex
            )
                throw Error("Tracking matched another transaction");
            if (tracking.status === "pending_source") {
                record.state = "pending_source";
                record.sourceState = "pending_source";
                record.transactionHash = fact.transactionHash;
                record.locator = clone(fact.locator);
                return this.save(record, previous);
            }
        }
        if (fact.status !== "confirmed") return clone(record);
        if (record.state === "recognized" || record.state === "proof_rejected")
            return clone(record);
        if (record.deliveryMode === "direct" && !record.jobId) {
            // Save the locator before submission; retries use the same idempotency key after uncertain responses.
            const saved = await this.save(record, previous);
            Object.assign(record, saved);
            checkCancelled(options.signal);
            const result = await this.service.submitProof(
                clone(record.locator!),
                clone(record.sidecar.proofBundle),
                recoverySubmissionKey(record.idempotencyKey, record.sidecar)
            );
            if (typeof result.jobId !== "string" || !result.jobId)
                throw Error("Missing recovery job id");
            record.jobId = result.jobId;
            record.state = "pending";
            await this.save(record, record.revision);
        }
        checkCancelled(options.signal);
        if (record.deliveryMode === "direct" && !record.proofValid) {
            const job = await this.service.getProofJob(record.jobId!);
            if (
                ![
                    "queued",
                    "verifying",
                    "retryable_error",
                    "valid",
                    "invalid",
                    "stale_generation",
                ].includes(String(job.status))
            )
                throw Error("Unsupported proof job status");
            record.proofJobStatus = String(job.status);
            delete record.reasonCode;
            if (typeof job.reasonCode === "string") record.reasonCode = job.reasonCode;
            if (job.status === "invalid") record.state = "proof_rejected";
            else if (job.status === "valid") {
                record.proofValid = true;
                record.state = "pending_source";
            } else if (job.status === "stale_generation") record.state = "needs_reproof";
            else record.state = "pending";
            await this.save(record, record.revision);
        }
        if (record.proofValid || record.deliveryMode === "tracked") {
            const recognition = await this.service.getOperationRecognition(clone(record.locator!));
            if (typeof recognition.recognitionState !== "string")
                throw Error("Missing operation recognition state");
            const operation = recognition.operation as Record<string, unknown> | undefined;
            if (!operation || operation.canonical !== true || operation.success !== true)
                throw Error("Missing canonical recognized operation");
            for (const k of ["blockHash", "txHash", "operationIndex"] as const)
                if (String(operation[k]) !== record.locator![k])
                    throw Error("Recognition locator mismatch");
            for (const k of [
                "chainId",
                "protocolAddress",
                "tokenAddress",
                "operationDigest",
            ] as const)
                if (BigInt(String(operation[k])) !== BigInt(record.intent[k]))
                    throw Error("Recognition statement mismatch");
            if (
                !Array.isArray(operation.noteNullifiers) ||
                operation.noteNullifiers.length !== record.intent.inputNullifiers.length ||
                operation.noteNullifiers.some(
                    (n, i) => BigInt(String(n)) !== BigInt(record.intent.inputNullifiers[i]!)
                )
            )
                throw Error("Recognition nullifiers mismatch");
            record.sourceState = recognition.recognitionState;
            const details = recognition.recognition as Record<string, unknown> | undefined;
            delete record.reasonCode;
            if (typeof details?.reasonCode === "string") record.reasonCode = details.reasonCode;
            if (typeof details?.checkpointSequence === "string")
                record.checkpointSequence = details.checkpointSequence;
            if (
                record.sourceState === "recognized" &&
                (!record.checkpointSequence || uint(record.checkpointSequence, 64) < 1n)
            )
                throw Error("Missing recognition checkpoint");
            record.state =
                record.sourceState === "recognized"
                    ? "recognized"
                    : record.sourceState === "source_rejected"
                      ? "source_rejected"
                      : "pending_source";
        }
        return this.save(record, record.revision);
    }
    async run(
        id: string,
        options: {
            signal?: AbortSignal;
            reprove?: boolean;
            pollMilliseconds?: number;
            maxPolls?: number;
        } = {}
    ): Promise<RecoveryRecord> {
        const interval = options.pollMilliseconds ?? 1000,
            limit = options.maxPolls ?? 120;
        if (
            !Number.isFinite(interval) ||
            interval <= 0 ||
            !Number.isSafeInteger(limit) ||
            limit < 1
        )
            throw Error("Invalid recovery polling limits");
        for (let i = 0; i < limit; i++) {
            const record = await this.resume(id, options);
            if (
                !["broadcast_possible", "broadcast", "pending", "pending_source"].includes(
                    record.state
                )
            )
                return record;
            await new Promise<void>((resolve, reject) => {
                const signal = options.signal;
                const finish = () => {
                    signal?.removeEventListener("abort", abort);
                    resolve();
                };
                const timer = setTimeout(finish, interval);
                const abort = () => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", abort);
                    reject(Error("Local recovery cancelled; broadcast remains active"));
                };
                signal?.addEventListener("abort", abort, { once: true });
                if (signal?.aborted) abort();
            });
        }
        throw Error("Recovery polling limit reached; resume remains available");
    }
}
/** Local membership filtering does not imply protocol spendability or disclose per-note interest. */
export async function filterRecognizedCommitments(
    scope: Scope,
    tree: RecognizedTree,
    commitments: string[]
): Promise<string[]> {
    const out: string[] = [];
    for (const c of commitments) {
        const membership = await tree.membershipForCommitment(scope, c);
        if (membership) out.push(c);
    }
    return out;
}
