import { it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { getBytes, hexlify, sha256, keccak256, Transaction } from "ethers";
import { ProvenanceClient } from "@invisi-labs/rpc/provenance";
import {
    verifyRotationChain,
    withRotationHistory,
    word,
    type ProofSidecar,
    type TrustContext,
    type RotationRecord,
} from "@invisi-labs/protocol/provenance";
import { authenticateManifest } from "@invisi-labs/sdk/provenance";
import {
    EncryptedRecoveryStore,
    RecoveryCoordinator,
    type FrozenProvenanceIntent,
    type RecoveryHost,
} from "./recovery";
const enabled = process.env.INVISI_PROVENANCE_RECOVERY_LIVE === "1";
const pin = "6107789c5c0d24c4130bff05da6d389336feb5ccb247c4030eae5198ab05d762";
it.skipIf(!enabled)(
    "LIVE recovery: primary reconciliation,local BB verification,encrypted restart,invalid job and operation recognition",
    async () => {
        const path = process.env.INVISI_PROVENANCE_TRUST;
        if (!path) throw Error("Public operator trust file required");
        const f = JSON.parse(readFileSync(path, "utf8")),
            r = f.recovery;
        expect(f.manifestSha256).toBe(pin);
        expect(r).toBeTruthy();
        for (const endpoint of [f.endpoint, r.primaryRPC])
            expect(["127.0.0.1", "localhost", "[::1]"]).toContain(new URL(endpoint).hostname);
        expect(sha256(getBytes(f.initialSigningPublicKey))).toBe(f.initialSigningKeyId);
        const history = verifyRotationChain(
            {
                providerId: f.providerId,
                keys: { [f.initialSigningKeyId]: getBytes(f.initialSigningPublicKey) },
                previousRotationHash: word(0),
                lastActivatedAt: "0",
                now: f.checkedAt,
            },
            f.keyRotations as RotationRecord[]
        );
        expect(hexlify(history.keys[f.currentSigningKeyId]!)).toBe(f.currentSigningPublicKey);
        const trust: TrustContext = withRotationHistory(
                {
                    ...f.scope,
                    chainGeneration: f.chainGeneration,
                    providerId: f.providerId,
                    manifestSha256: pin,
                    signingKeys: history.keys,
                },
                history
            ),
            client = new ProvenanceClient(f.endpoint, trust);
        await client.getVersion();
        await client.getStatus();
        const intent: FrozenProvenanceIntent = {
            ...f.scope,
            tokenAddress: r.tokenAddress,
            operationIndex: r.operationIndex,
            operationDigest: r.operationDigest,
            inputNullifiers: r.inputNullifiers,
            calldata: r.calldata,
            calldataHash: keccak256(r.calldata),
            signedRequestHash: r.transactionHash,
        };
        const manifest = readFileSync(join(r.protocolRoot, "circuits/provenance/manifest.json")),
            identity = authenticateManifest(manifest, pin);
        const capacity = Number(r.sidecar.proofBundle.circuitId.replace("provenance_k", ""));
        const entry = identity.manifest.circuits.find(
            (e) => e.capacity === capacity
        )! as unknown as {
            vk: string;
            vkSha256: string;
        };
        const vk = join(r.protocolRoot, entry.vk);
        expect(sha256(readFileSync(vk)).slice(2)).toBe(entry.vkSha256);
        const bb = join(r.protocolRoot, ".tools/bb/bb");
        expect(spawnSync(bb, ["--version"], { encoding: "utf8" }).stdout.trim()).toBe("6.0.0");
        const signed = Transaction.from(r.signedTransaction);
        expect(signed.hash).toBe(r.transactionHash);
        expect(signed.data).toBe(r.calldata);
        expect(signed.chainId).toBe(BigInt(f.scope.chainId));
        let primaryCalls = 0,
            nativeVerifications = 0;
        const rpc = async (method: string, params: unknown[]) => {
            primaryCalls++;
            const response = await fetch(r.primaryRPC, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: primaryCalls, method, params }),
            });
            const value = (await response.json()) as {
                result: Record<string, unknown>;
                error?: unknown;
            };
            if (value.error) throw Error(JSON.stringify(value.error));
            return value.result;
        };
        const reconcile = async () => {
            const chain = (await rpc("eth_chainId", [])) as unknown as string;
            expect(BigInt(chain)).toBe(BigInt(f.scope.chainId));
            const tx = await rpc("eth_getTransactionByHash", [r.transactionHash]),
                receipt = await rpc("eth_getTransactionReceipt", [r.transactionHash]);
            expect(tx.hash).toBe(r.transactionHash);
            expect(String(tx.to).toLowerCase()).toBe(
                "0x" + BigInt(f.scope.protocolAddress).toString(16).padStart(40, "0")
            );
            expect(tx.input).toBe(r.calldata);
            expect(String(tx.from).toLowerCase()).toBe(signed.from!.toLowerCase());
            expect(receipt.transactionHash).toBe(r.transactionHash);
            expect(BigInt(String(receipt.status))).toBe(1n);
            expect(receipt.blockHash).toBe(r.blockHash);
            const header = await rpc("eth_getBlockByNumber", [receipt.blockNumber, false]);
            expect(header.hash).toBe(receipt.blockHash);
            expect(header.transactions).toContain(r.transactionHash);
            expect(tx.blockHash).toBe(header.hash);
            return {
                status: "confirmed" as const,
                calldataHash: keccak256(String(tx.input)),
                signedRequestHash: String(tx.hash),
                transactionHash: String(tx.hash),
                chainGeneration: f.chainGeneration,
                locator: {
                    blockHash: String(header.hash),
                    txHash: String(tx.hash),
                    operationIndex: r.operationIndex,
                },
            };
        };
        const verify = (sidecar: ProofSidecar) => {
            const dir = mkdtempSync(join(tmpdir(), "invisi-recovery-live-"));
            try {
                writeFileSync(join(dir, "proof"), getBytes(sidecar.proofBundle.proof));
                writeFileSync(
                    join(dir, "inputs"),
                    Buffer.concat(
                        sidecar.proofBundle.publicInputs.map((v) => Buffer.from(getBytes(v)))
                    )
                );
                const result = spawnSync(
                    bb,
                    [
                        "verify",
                        "-t",
                        "evm",
                        "-k",
                        vk,
                        "-p",
                        join(dir, "proof"),
                        "-i",
                        join(dir, "inputs"),
                    ],
                    { encoding: "utf8", env: { ...process.env, HARDWARE_CONCURRENCY: "4" } }
                );
                if (
                    result.status !== 0 ||
                    !(result.stdout + result.stderr).includes("Proof verified successfully")
                )
                    throw Error("Native proof verification rejected");
                nativeVerifications++;
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        };
        const host: RecoveryHost = {
            verifyFrozenStatement: async (value, sidecar) => {
                expect(value).toEqual(intent);
                await reconcile();
                verify(sidecar);
            },
            reconcileFrozenTransaction: async () => reconcile(),
            localReprove: async () => structuredClone(r.sidecar),
        };
        const raw = new Map<string, { revision: number; data: Uint8Array }>(),
            records = {
                read: async (key: string) => raw.get(key),
                compareAndSwap: async (
                    key: string,
                    old: number,
                    next: { revision: number; data: Uint8Array }
                ) => {
                    if ((raw.get(key)?.revision ?? 0) !== old) return false;
                    raw.set(key, structuredClone(next));
                    return true;
                },
            },
            key = new Uint8Array(32).fill(17);
        let store = await EncryptedRecoveryStore.fromBytes(records, key),
            coordinator = new RecoveryCoordinator(store, client, host);
        const bad = structuredClone(r.sidecar) as ProofSidecar;
        const bytes = getBytes(bad.proofBundle.proof);
        bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
        bad.proofBundle.proof = hexlify(bytes);
        await expect(
            coordinator.prepareDirect("bad-local", intent, bad, "ts-bad-local")
        ).rejects.toThrow("Native proof");
        expect(await store.load("bad-local")).toBeUndefined();
        const id = "ts-recovery-live",
            base = "ts-recovery-" + Date.now();
        await coordinator.prepareDirect(id, intent, r.sidecar, base);
        expect((await store.load(id))!.state).toBe("broadcast_possible");
        expect(new TextDecoder().decode([...raw.values()][0]!.data)).not.toContain(r.calldata);
        if (r.invalidJobId) {
            const saved = (await store.load(id))!;
            const fact = await reconcile();
            saved.jobId = r.invalidJobId;
            saved.locator = fact.locator;
            saved.transactionHash = fact.transactionHash;
            saved.state = "pending";
            const revision = saved.revision;
            saved.revision++;
            expect(await store.compareAndSwap(id, revision, saved)).toBe(true);
            const invalid = await coordinator.resume(id);
            expect(invalid.state).toBe("proof_rejected");
            expect(invalid.proofJobStatus).toBe("invalid");
            expect(invalid.reasonCode).toBe("PROOF_INVALID");
        }
        store = await EncryptedRecoveryStore.fromBytes(records, key);
        coordinator = new RecoveryCoordinator(store, client, host);
        const result = await coordinator.run(id, {
            reprove: Boolean(r.invalidJobId),
            pollMilliseconds: 100,
            maxPolls: 300,
        });
        expect(result.state).toBe("recognized");
        expect(result.reasonCode).not.toBe("PROOF_INVALID");
        expect(result.intent).toEqual(intent);
        expect(result.proofValid).toBe(true);
        expect(result.sourceState).toBe("recognized");
        expect(result.checkpointSequence).toBeTruthy();
        const trackedService = {
            trust: client.trust,
            evaluateTransaction: client.evaluateTransaction.bind(client),
            submitSourceProof: client.submitSourceProof.bind(client),
            getTracking: client.getTracking.bind(client),
            getOperationRecognition: client.getOperationRecognition.bind(client),
            submitProof: async () => {
                throw Error("Tracked recovery must not submit proof");
            },
            getProofJob: async () => {
                throw Error("Tracked recovery must not fetch a proof job");
            },
        };
        const automatic = new RecoveryCoordinator(store, trackedService, host);
        const trackedPermit = await automatic.prepare(
            "ts-tracked-live",
            intent,
            r.sidecar,
            "ts-tracked-" + Date.now()
        );
        expect(trackedPermit.record.trackingId).toBe(r.trackingId);
        expect((await store.load("ts-tracked-live"))!.trackingId).toBe(r.trackingId);
        const trackedResult = await automatic.run("ts-tracked-live", {
            pollMilliseconds: 100,
            maxPolls: 300,
        });
        expect(trackedResult.state).toBe("recognized");
        expect(trackedResult.intent).toEqual(intent);
        writeFileSync(
            join(dirname(path), "sdk-recovery-ts-validation.json"),
            JSON.stringify(
                {
                    sdk: "typescript",
                    manifestSha256: pin,
                    realPrimaryHTTP: true,
                    primaryCalls,
                    realNativeVerification: true,
                    nativeVerifications,
                    encryptedRestart: true,
                    trackedRecovery: true,
                    trackingId: trackedResult.trackingId,
                    badLocalProofRejected: true,
                    reasonCode: result.reasonCode,
                    invalidJobImported: Boolean(r.invalidJobId),
                    jobStatus: result.proofJobStatus,
                    state: result.state,
                    jobId: result.jobId,
                    checkpointSequence: result.checkpointSequence,
                    frozenTransactionHash: result.transactionHash,
                    mocks: false,
                },
                null,
                2
            ) + "\n"
        );
    },
    120000
);
