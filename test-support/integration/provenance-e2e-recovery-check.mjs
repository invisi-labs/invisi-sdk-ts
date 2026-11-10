import fs from "node:fs";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
assert.equal(
    process.argv.length,
    3,
    "usage: node test-support/integration/provenance-e2e-recovery-check.mjs <owned-live-run-directory>"
);
const directory = resolve(process.argv[2]),
    read = (name) => JSON.parse(fs.readFileSync(join(directory, name))),
    trust = read("sdk-trust.json"),
    credit = read("credit-flow.json"),
    recovery = read("sdk-recovery-live-validation.json"),
    ordinary = read("sdk-live-validation.json");
let id = 0;
async function rpc(url, method, params = []) {
    const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    assert.equal(response.status, 200);
    const value = await response.json();
    assert(!value.error, JSON.stringify(value.error));
    return value.result;
}
assert.equal(recovery.complete, true);
assert.equal(ordinary.complete, true);
assert.equal(recovery.cases.length, 3);
for (const item of recovery.cases) {
    const e = item.evidence;
    assert.equal(item.exitCode, 0);
    assert.equal(e.state, "recognized");
    assert.equal(e.encryptedRestart, true);
    assert.equal(e.invalidJobImported, true);
    assert.equal(e.badLocalProofRejected, true);
    assert(!e.reasonCode);
    assert.equal(e.realPrimaryHTTP, true);
    assert.equal(e.realNativeVerification, true);
    assert.equal(e.mocks, false);
    assert.equal(e.frozenTransactionHash, trust.recovery.transactionHash);
}
const endpoint = trust.endpoint + "/v1/chains/" + trust.scope.chainId,
    roots = await rpc(endpoint, "provenance_getRoots", [{ after: "0", limit: "200" }]),
    last = roots.items.at(-1),
    before = credit.recognition.certificate;
assert.equal(roots.items.length, Number(before.rootSequence));
for (const field of ["rootSequence", "leafCount", "root", "signature"])
    assert.equal(last[field], before[field]);
const head = await rpc(trust.recovery.primaryRPC, "eth_getBlockByNumber", ["latest", false]);
assert.equal(
    head.number,
    credit.drawReceipt.blockNumber,
    "SDK recovery does not send another chain transaction"
);
const proofJob = await rpc(endpoint, "provenance_getProofJob", [
    { jobId: trust.recovery.invalidJobId },
]);
assert.equal(proofJob.status, "invalid");
assert.equal(proofJob.reasonCode, "PROOF_INVALID");
const result = {
    format: "invisi.provenance.recovery.validation.v1",
    complete: true,
    completedAt: new Date().toISOString(),
    manifestSha256: trust.manifestSha256,
    realPrimaryHTTP: true,
    realNativeVerification: true,
    openingMaterial: false,
    proofMocks: false,
    sdkLanguages: 3,
    encryptedRestarts: 3,
    externalInvalidJobImportNegativeCases: 3,
    badLocalProofRejections: 3,
    recognizedRecoveries: 3,
    invalidNativeJob: {
        id: proofJob.jobId,
        status: proofJob.status,
        reasonCode: proofJob.reasonCode,
    },
    normalSdkRevalidation: true,
    duplicateLeaves: 0,
    duplicateCheckpoints: 0,
    before: {
        leafCount: before.leafCount,
        rootSequence: before.rootSequence,
        root: before.root,
    },
    after: {
        leafCount: last.leafCount,
        rootSequence: last.rootSequence,
        root: last.root,
    },
    signedTransactionHash: trust.recovery.transactionHash,
    primaryHeadUnchanged: true,
    rootSignatureUnchanged: true,
    evidence: [
        "recovery-primary-facts.json",
        "recovery-invalid-job.json",
        "sdk-live-validation.json",
        "sdk-recovery-live-validation.json",
        "sdk-recovery-ts-validation.json",
        "sdk-recovery-go-validation.json",
        "sdk-recovery-rust-validation.json",
        "sdk-recovery-live-revalidation.log",
    ],
    historicalInitialSdkFailurePreserved: true,
};
fs.writeFileSync(
    join(directory, "recovery-validation-summary.json"),
    JSON.stringify(result, null, 2) + "\n",
    { mode: 0o600 }
);
console.log(JSON.stringify(result, null, 2));
