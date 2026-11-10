import { it, expect } from "vitest";
import {
    EncryptedRecoveryStore,
    recoverySubmissionKey,
    RecoveryCoordinator,
    type AtomicRecoveryRecords,
} from "./recovery";
import { keccak256 } from "ethers";

it("encrypts detached recovery state, authenticates purpose/revision/key and fences stale CAS", async () => {
    const values = new Map<string, { revision: number; data: Uint8Array }>();
    const records: AtomicRecoveryRecords = {
        read: async (key) => values.get(key),
        compareAndSwap: async (key, old, next) => {
            if ((values.get(key)?.revision ?? 0) !== old) return false;
            values.set(key, structuredClone(next));
            return true;
        },
    };
    const store = await EncryptedRecoveryStore.fromBytes(records, new Uint8Array(32).fill(7));
    const value = {
        format: "invisi-provenance-recovery-v1",
        deliveryMode: "direct",
        revision: 1,
        id: "one",
        intent: fixtures.intent,
        manifestSha256: fixtures.manifestSha256,
        chainGeneration: "1",
        sidecar: fixtures.sidecars[0],
        idempotencyKey: "stable",
        state: "broadcast_possible",
    } as RecoveryRecord;
    expect(await store.compareAndSwap("one", 0, value)).toBe(true);
    expect(new TextDecoder().decode([...values.values()][0]!.data)).not.toContain(
        fixtures.intent.calldata
    );
    expect(await store.load("one")).toEqual(value);
    expect(await store.compareAndSwap("one", 0, value)).toBe(false);
    const wrong = await EncryptedRecoveryStore.fromBytes(records, new Uint8Array(32).fill(8));
    await expect(wrong.load("one")).rejects.toThrow();
    values.set(
        "Invisi.Provenance.Recovery.v1:two",
        values.get("Invisi.Provenance.Recovery.v1:one")!
    );
    await expect(store.load("two")).rejects.toThrow();
    values.get("Invisi.Provenance.Recovery.v1:one")!.revision = 2;
    await expect(store.load("one")).rejects.toThrow();
});
import fixtures from "./recovery-vectors.json";
import { getBytes } from "ethers";
import type {
    RecoveryRecord,
    RecoveryReconciliation,
    RecoveryHost,
    RecoveryService,
    FrozenProvenanceIntent,
} from "./recovery";
import type { ProofSidecar } from "@invisi-labs/protocol/provenance";

async function recoveryHarness() {
    const records = new Map<string, { revision: number; data: Uint8Array }>();
    let rejectCAS = false;
    const store = await EncryptedRecoveryStore.fromBytes(
        {
            read: async (id) => records.get(id),
            compareAndSwap: async (id, old, next) => {
                if (rejectCAS || (records.get(id)?.revision ?? 0) !== old) return false;
                records.set(id, structuredClone(next));
                return true;
            },
        },
        new Uint8Array(32).fill(7)
    );
    const trust = {
        ...fixtures.scope,
        chainGeneration: "1",
        providerId: fixtures.providerId,
        manifestSha256: fixtures.manifestSha256,
        signingKeys: { [fixtures.signingKeyId]: getBytes(fixtures.publicKey) },
    };
    let fact: RecoveryReconciliation = {
        status: "confirmed",
        calldataHash: fixtures.intent.calldataHash,
        signedRequestHash: fixtures.intent.signedRequestHash,
        chainGeneration: "1",
        transactionHash: "0x" + "ab".repeat(32),
        locator: {
            txHash: "0x" + "ab".repeat(32),
            blockHash: "0x" + "cd".repeat(32),
            operationIndex: "0",
        },
    };
    let failRecognition = false;
    let submits = 0,
        failSubmit = false,
        recognition = "pending_source",
        reconciles = 0;
    const keys: string[] = [];
    const service: RecoveryService = {
        trust,
        evaluateTransaction: async () => {
            throw Error("Explicit direct fixture has no preflight");
        },
        getTracking: async () => {
            throw Error("No direct tracking");
        },
        submitProof: async (_locator, _bundle, key) => {
            submits++;
            keys.push(key);
            if (failSubmit) {
                failSubmit = false;
                throw Error("network interrupted after accepted");
            }
            return { jobId: "job1" };
        },
        getProofJob: async () => ({ status: "valid" }),
        getOperationRecognition: async (locator) => {
            if (failRecognition) {
                failRecognition = false;
                throw Error("provider outage");
            }
            return {
                operation: {
                    ...fixtures.intent,
                    ...locator,
                    noteNullifiers: fixtures.intent.inputNullifiers,
                    canonical: true,
                    success: true,
                },
                recognitionState: recognition,
                recognition: { reasonCode: "DEPENDENCIES_PENDING", checkpointSequence: "3" },
            };
        },
    };
    const host: RecoveryHost = {
        verifyFrozenStatement: async (intent) => {
            expect(intent).toEqual(fixtures.intent);
        },
        reconcileFrozenTransaction: async () => {
            reconciles++;
            return structuredClone(fact);
        },
        localReprove: async () => structuredClone(fixtures.sidecars[1]!) as ProofSidecar,
    };
    const coordinator = () => new RecoveryCoordinator(store, service, host);
    return {
        store,
        coordinator,
        service,
        host,
        records,
        get fact() {
            return fact;
        },
        set fact(v) {
            fact = v;
        },
        get submits() {
            return submits;
        },
        get keys() {
            return keys;
        },
        get reconciles() {
            return reconciles;
        },
        reject: () => {
            rejectCAS = true;
        },
        interrupt: () => {
            failSubmit = true;
        },
        recognitionOutage: () => {
            failRecognition = true;
        },
        rejectSource: () => {
            recognition = "source_rejected";
        },
        recognized: () => {
            recognition = "recognized";
        },
    };
}
it("persists before broadcast and resumes uncertain submission across restart without equating job validity to recognition", async () => {
    const h = await recoveryHarness();
    const first = h.coordinator();
    const permit = await first.prepareDirect(
        "send1",
        fixtures.intent,
        fixtures.sidecars[0]! as ProofSidecar,
        "stable"
    );
    expect(permit.broadcastPermit).toBe(true);
    expect((await h.store.load("send1"))?.state).toBe("broadcast_possible");
    await first.markBroadcast("send1", h.fact.transactionHash!);
    h.interrupt();
    await expect(first.resume("send1")).rejects.toThrow("network");
    const pending = await h.coordinator().resume("send1");
    expect(pending.state).toBe("pending_source");
    expect(pending.proofValid).toBe(true);
    expect(h.keys).toEqual([
        recoverySubmissionKey("stable", fixtures.sidecars[0]! as ProofSidecar),
        recoverySubmissionKey("stable", fixtures.sidecars[0]! as ProofSidecar),
    ]);
    h.recognized();
    const recognized = await h.coordinator().run("send1", { pollMilliseconds: 1, maxPolls: 2 });
    expect(recognized.state).toBe("recognized");
    expect(recognized.checkpointSequence).toBe("3");
    expect(h.submits).toBe(2);
    expect(recognized.intent).toEqual(fixtures.intent);
});
it("fences CAS, cancellation, mismatched statements and old generation after transaction reconciliation", async () => {
    const h = await recoveryHarness();
    h.reject();
    await expect(
        h
            .coordinator()
            .prepareDirect(
                "blocked",
                fixtures.intent,
                fixtures.sidecars[0]! as ProofSidecar,
                "stable"
            )
    ).rejects.toThrow("CAS");
    expect(await h.store.load("blocked")).toBeUndefined();
    const p = await recoveryHarness();
    await p
        .coordinator()
        .prepareDirect("send", fixtures.intent, fixtures.sidecars[0]! as ProofSidecar, "stable");
    await p.coordinator().markBroadcast("send", p.fact.transactionHash!);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(p.coordinator().resume("send", { signal: cancelled.signal })).rejects.toThrow(
        "cancelled"
    );
    expect((await p.store.load("send"))?.state).toBe("broadcast");
    expect(p.submits).toBe(0);
    p.fact = { ...p.fact, chainGeneration: "2" };
    const old = await p.coordinator().resume("send");
    expect(p.reconciles).toBe(1);
    expect(old.state).toBe("needs_reproof");
    expect(p.submits).toBe(0);
    p.service.trust.chainGeneration = "2";
    const originalReprover = p.host.localReprove!;
    p.host.localReprove = async () => {
        const bad = structuredClone(fixtures.sidecars[1]!) as ProofSidecar;
        bad.proofBundle.publicInputs[2] = "0x" + "0".repeat(63) + "3";
        return bad;
    };
    await expect(p.coordinator().resume("send", { reprove: true })).rejects.toThrow("statement");
    expect((await p.store.load("send"))?.chainGeneration).toBe("1");
    expect(p.submits).toBe(0);
    p.host.localReprove = originalReprover;
    p.recognized();
    const reproved = await p.coordinator().resume("send", { reprove: true });
    expect(reproved.state).toBe("recognized");
    expect(reproved.intent).toEqual(fixtures.intent);
    expect(p.keys).toEqual([
        recoverySubmissionKey("stable", fixtures.sidecars[1]! as ProofSidecar),
    ]);
    const bad = await recoveryHarness();
    await expect(
        bad
            .coordinator()
            .prepareDirect(
                "bad",
                { ...fixtures.intent, operationDigest: "5" },
                fixtures.sidecars[0]! as ProofSidecar,
                "stable"
            )
    ).rejects.toThrow("statement");
});

it("derives the same canonical bundle submission keys as the shared recovery vectors", () => {
    for (let i = 0; i < 2; i++)
        expect(recoverySubmissionKey("stable", fixtures.sidecars[i]! as ProofSidecar)).toBe(
            fixtures.submissionKeys[i]
        );
});

it("waits for confirmation after a crash immediately after handing out the durable permit", async () => {
    const h = await recoveryHarness();
    await h
        .coordinator()
        .prepareDirect(
            "possible",
            fixtures.intent,
            fixtures.sidecars[0]! as ProofSidecar,
            "stable"
        );
    let calls = 0;
    h.host.reconcileFrozenTransaction = async () => {
        calls++;
        if (calls === 1) {
            expect(h.submits).toBe(0);
            return { ...h.fact, status: "pending" };
        }
        return h.fact;
    };
    h.recognized();
    const result = await h.coordinator().run("possible", { pollMilliseconds: 1, maxPolls: 2 });
    expect(result.state).toBe("recognized");
    expect(result.transactionHash).toBe(h.fact.transactionHash);
    expect(calls).toBe(2);
    expect(h.submits).toBe(1);
});

it("retains proof-valid pending source across provider outage and can resume a changed source decision", async () => {
    const h = await recoveryHarness();
    await h
        .coordinator()
        .prepareDirect("pending", fixtures.intent, fixtures.sidecars[0]! as ProofSidecar, "stable");
    h.recognitionOutage();
    await expect(h.coordinator().resume("pending")).rejects.toThrow("provider outage");
    const saved = await h.store.load("pending");
    expect(saved?.proofValid).toBe(true);
    expect(saved?.state).toBe("pending_source");
    h.rejectSource();
    expect((await h.coordinator().resume("pending")).state).toBe("source_rejected");
    h.recognized();
    expect((await h.coordinator().resume("pending")).state).toBe("recognized");
    expect(h.submits).toBe(1);
});

it("checks the service idempotency boundary before returning any broadcast permit", async () => {
    const h = await recoveryHarness();
    const sidecar = fixtures.sidecars[0]! as ProofSidecar;
    expect(recoverySubmissionKey("a".repeat(63), sidecar)).toBe(
        fixtures.idempotencyLimits.maxBaseSubmissionKey
    );
    expect(recoverySubmissionKey("a".repeat(63), sidecar).length).toBe(128);
    await h.coordinator().prepareDirect("max", fixtures.intent, sidecar, "a".repeat(63));
    for (const base of ["a".repeat(64), "a".repeat(128), "é", " "]) {
        await expect(
            h.coordinator().prepareDirect("blocked" + base.length, fixtures.intent, sidecar, base)
        ).rejects.toThrow();
        expect(await h.store.load("blocked" + base.length)).toBeUndefined();
    }
});

it("changes the submission key for a replacement bundle in the same generation", () => {
    const sidecar = structuredClone(fixtures.sidecars[0]!) as ProofSidecar;
    const old = recoverySubmissionKey("stable", sidecar);
    sidecar.proofBundle.proof = "0x02";
    expect(recoverySubmissionKey("stable", sidecar)).not.toBe(old);
});

it("refuses opening-shaped extension fields before persistence", async () => {
    const h = await recoveryHarness();
    const unsafe = {
        ...fixtures.intent,
        openings: ["raw private material"],
    } as FrozenProvenanceIntent;
    await expect(
        h
            .coordinator()
            .prepareDirect("unsafe", unsafe, fixtures.sidecars[0]! as ProofSidecar, "stable")
    ).rejects.toThrow("Unknown recovery field");
    expect(await h.store.load("unsafe")).toBeUndefined();
});

it("handles real proof-job wire states separately from source rejection", async () => {
    const h = await recoveryHarness();
    await h
        .coordinator()
        .prepareDirect("invalid", fixtures.intent, fixtures.sidecars[0]! as ProofSidecar, "stable");
    h.service.getProofJob = async () => ({ status: "invalid", reasonCode: "PROOF_INVALID" });
    expect((await h.coordinator().resume("invalid")).state).toBe("proof_rejected");
    const replacement = structuredClone(fixtures.sidecars[0]!) as ProofSidecar;
    replacement.proofBundle.proof = "0x02";
    h.host.localReprove = async () => replacement;
    h.service.getProofJob = async () => ({ status: "valid" });
    h.recognized();
    const fixed = await h.coordinator().resume("invalid", { reprove: true });
    expect(fixed.state).toBe("recognized");
    expect(fixed.intent).toEqual(fixtures.intent);
    expect(h.keys).toHaveLength(2);
    expect(h.keys[0]).not.toBe(h.keys[1]);
    for (const status of ["retryable_error", "stale_generation"]) {
        const p = await recoveryHarness();
        await p
            .coordinator()
            .prepareDirect(
                status,
                fixtures.intent,
                fixtures.sidecars[0]! as ProofSidecar,
                "stable"
            );
        p.service.getProofJob = async () => ({
            status,
            reasonCode:
                status === "retryable_error" ? "VERIFIER_UNAVAILABLE" : "CHAIN_GENERATION_CHANGED",
        });
        const result = await p.coordinator().resume(status);
        expect(result.state).toBe(status === "retryable_error" ? "pending" : "needs_reproof");
        expect(result.proofJobStatus).toBe(status);
        expect(result.proofValid).not.toBe(true);
        expect(p.submits).toBe(1);
    }
});

it("defaults to durable preflight tracking and never redundantly submits a matched transaction", async () => {
    const h = await recoveryHarness();
    let evaluations = 0,
        queries = 0;
    const id = "a".repeat(48),
        tracking = {
            id,
            status: "recognized" as const,
            operationDigest:
                "0x" + BigInt(fixtures.intent.operationDigest).toString(16).padStart(64, "0"),
            expiresAt: "1",
            matched: h.fact.locator as {
                txHash: string;
                blockHash: string;
                operationIndex: string;
            },
        };
    h.service.evaluateTransaction = async (data, sidecars) => {
        evaluations++;
        expect(data).toBe(fixtures.intent.calldata);
        expect(sidecars).toEqual([fixtures.sidecars[0]]);
        sidecars[0]!.proofBundle.publicInputs[2] = "0x" + "0".repeat(63) + "3";
        return {
            scope: fixtures.scope,
            broadcastDecision: "allow",
            operationDigest: fixtures.intent.operationDigest,
            tracking,
        };
    };
    h.service.getTracking = async (value) => {
        queries++;
        expect(value).toBe(id);
        return { scope: fixtures.scope, tracking };
    };
    h.recognized();
    const permit = await h
        .coordinator()
        .prepare("tracked", fixtures.intent, fixtures.sidecars[0]! as ProofSidecar, "stable");
    expect(permit.record.trackingId).toBe(id);
    expect((await h.store.load("tracked"))?.trackingId).toBe(id);
    const result = await h.coordinator().run("tracked", { pollMilliseconds: 1, maxPolls: 2 });
    expect(result.state).toBe("recognized");
    expect(evaluations).toBe(1);
    expect(queries).toBe(1);
    expect(h.submits).toBe(0);
});
it("refuses a permit without preflight tracking and never silently downgrades", async () => {
    const h = await recoveryHarness();
    h.service.evaluateTransaction = async () => ({
        scope: fixtures.scope,
        broadcastDecision: "allow",
        operationDigest: fixtures.intent.operationDigest,
    });
    await expect(
        h
            .coordinator()
            .prepare("missing", fixtures.intent, fixtures.sidecars[0]! as ProofSidecar, "stable")
    ).rejects.toThrow("tracking");
    expect(await h.store.load("missing")).toBeUndefined();
    expect(h.submits).toBe(0);
});

it("does not persist or return a permit for terminal preflight tracking despite an allow decision", async () => {
    for (const status of ["expired", "superseded"]) {
        const h = await recoveryHarness();
        h.service.evaluateTransaction = async () => ({
            scope: fixtures.scope,
            broadcastDecision: "allow",
            operationDigest: fixtures.intent.operationDigest,
            tracking: {
                id: "a".repeat(48),
                status,
                expiresAt: "1",
                operationDigest:
                    "0x" + BigInt(fixtures.intent.operationDigest).toString(16).padStart(64, "0"),
            },
        });
        await expect(
            h
                .coordinator()
                .prepare(
                    "terminal",
                    fixtures.intent,
                    fixtures.sidecars[0]! as ProofSidecar,
                    "stable"
                )
        ).rejects.toThrow("no longer permits broadcast");
        expect(await h.store.load("terminal")).toBeUndefined();
        expect(h.submits).toBe(0);
    }
});

it("rejects reserved internal idempotency bases before a recovery permit", async () => {
    const h = await recoveryHarness();
    await expect(
        h
            .coordinator()
            .prepareDirect(
                "reserved",
                fixtures.intent,
                fixtures.sidecars[0]! as ProofSidecar,
                "internal/test"
            )
    ).rejects.toThrow("reserved");
    expect(await h.store.load("reserved")).toBeUndefined();
});
it("rejects reserved internal submit keys before HTTP", async () => {
    const h = await recoveryHarness();
    let calls = 0;
    const { ProvenanceClient } = await import("@invisi-labs/rpc/provenance");
    const client = new ProvenanceClient("https://example.test", h.service.trust, (async () => {
        calls++;
        throw Error("unexpected HTTP");
    }) as typeof fetch);
    await expect(
        client.submitProof(
            {},
            fixtures.sidecars[0]!.proofBundle as ProofSidecar["proofBundle"],
            "internal/test"
        )
    ).rejects.toThrow("reserved");
    expect(calls).toBe(0);
});
