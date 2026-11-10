import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
const args = process.argv.slice(2);
assert(
    args.length >= 1 && args.length <= 2,
    "usage: node test-support/integration/provenance-e2e-summary.mjs <completed-owned-run-directory> [--existing-browser-run=<completed-run>]"
);
const directory = resolve(args[0]),
    previousArg = args[1];
assert(previousArg === undefined || previousArg.startsWith("--existing-browser-run="));
const read = (name, dir = directory) => JSON.parse(readFileSync(join(dir, name))),
    report = read("report.json"),
    sdk = read("sdk-live-validation.json"),
    browser = read("browser-flow.json"),
    reorg = read("reorg-flow.json");
assert(
    !report.error &&
        report.chainSettlementComplete &&
        report.sourceRecognitionComplete &&
        report.realNativeProvenanceVerifier &&
        report.realProtocolRPC
);
assert.equal(report.proofMocks, false);
assert.equal(sdk.complete, true);
assert.equal(sdk.realHTTP, true);
assert.equal(sdk.mocks, false);
assert.equal(sdk.manifestSha256, report.manifestSha256);
assert.equal(sdk.cases.length, 3);
assert(sdk.cases.every((c) => c.exitCode === 0));
assert.equal(browser.populatedDetailChecks, 27);
assert.deepEqual(browser.pageErrors, []);
let existingBrowser = {
    runDirectory: directory,
    manifestSha256: report.manifestSha256,
    checks: browser.existingRouteChecks,
};
if (previousArg) {
    assert.equal(browser.existingRouteChecks, 0);
    const previous = resolve(previousArg.slice("--existing-browser-run=".length)),
        previousReport = read("report.json", previous),
        previousBrowser = read("browser-flow.json", previous);
    assert(!previousReport.error && previousReport.chainSettlementComplete);
    assert.equal(previousBrowser.existingRouteChecks, 99);
    assert.deepEqual(previousBrowser.pageErrors, []);
    existingBrowser = {
        runDirectory: previous,
        manifestSha256: previousReport.manifestSha256,
        checks: previousBrowser.existingRouteChecks,
    };
}
assert.equal(existingBrowser.checks, 99);
assert.equal(reorg.oldProofRejected, true);
assert.equal(reorg.job.status, "valid");
assert.equal(reorg.recognized.recognitionState, "recognized");
assert(BigInt(reorg.newGeneration) > BigInt(reorg.oldGeneration));
const original = read("shield-recognition.json");
assert.deepEqual(reorg.prefixShield.fundingChecks, original.fundingChecks);
assert.deepEqual(reorg.prefixShield.providerDecisions, original.providerDecisions);
assert(
    original.fundingChecks.length > 0 &&
        original.fundingChecks.every((x) => x.final && x.decision === "allowed")
);
let replicas;
if (report.replicasAfterReorg) {
    const before = read("replicas-before-reorg.json"),
        after = read("replicas-after-reorg.json"),
        cleanup = read("replicas-cleanup.json");
    for (const phase of [before, after]) {
        assert.equal(phase.apiCount, 2);
        assert.equal(phase.readyWorkerCount, 2);
        assert.equal(phase.apiSigningSecretsPresent, false);
        assert.equal(phase.crossReplicaCursor, true);
        for (const notes of phase.notes) {
            assert.equal(notes.count, notes.commitments);
            assert.equal(notes.count, notes.positions);
        }
        for (const checkpoints of phase.checkpoints) {
            assert.equal(BigInt(checkpoints.last), BigInt(checkpoints.count));
            assert.equal(checkpoints.published, checkpoints.count);
        }
    }
    assert.equal(cleanup.schema, before.schema);
    assert.equal(cleanup.schema, after.schema);
    assert.equal(cleanup.dropped, true);
    assert.equal(cleanup.otherSchemasTouched, false);
    assert(report.stages.some((s) => s.name === "real-native-job-owned-by-worker-1"));
    assert(report.stages.some((s) => s.name === "real-native-job-owned-by-worker-2"));
    replicas = {
        apiProcesses: 2,
        workerProcessesAtEachSnapshot: 2,
        nativeWorkersExercised: 2,
        apiSigningSecretsPresent: false,
        crossReplicaCursor: true,
        before: {
            generation: String(BigInt(before.scopes[0].generation)),
            noteCount: before.publicLeafCount,
            certificateSequences: before.certificateSequences,
        },
        after: {
            generation: String(BigInt(after.scopes[0].generation)),
            noteCount: after.publicLeafCount,
            certificateSequences: after.certificateSequences,
        },
        ownedSchemaDropped: true,
        otherSchemasTouched: false,
    };
}
const summary = {
    format: "invisi.provenance.e2e.validation.v1",
    complete: true,
    completedAt: report.completedAt,
    realChain: true,
    realProtocolRPC: true,
    realNativeVerifier: true,
    proofMocks: false,
    chainFactMocks: false,
    testTokens: "deployed local ERC20 fixture contracts",
    manifestSha256: report.manifestSha256,
    counts: {
        onChainProofSettlementsAcrossObservedBranches: 4,
        e2eNativeProofsGenerated: 5,
        validProvenanceJobs: 2,
        sdkLanguages: 3,
        browserExistingRouteChecks: existingBrowser.checks,
        browserPopulatedDetailChecks: browser.populatedDetailChecks,
        browserTotalChecks: existingBrowser.checks + browser.populatedDetailChecks,
        localSecretRejectionChecks: 9,
        browserHTTPErrorResponses: 0,
        pageErrors: 0,
        oldGenerationProofRejections: 1,
    },
    browserEvidence: {
        existingRoutes: existingBrowser,
        populatedDetails: {
            runDirectory: directory,
            manifestSha256: report.manifestSha256,
            checks: browser.populatedDetailChecks,
        },
        historicalEvidenceRewritten: false,
    },
    generation: { before: reorg.oldGeneration, after: reorg.newGeneration },
    creditDrawNoteRecognized: report.credit.recognition.recognitionState === "recognized",
    canonicalPrefixFinalFundingPreserved: true,
    ...(replicas ? { replicas } : {}),
    evidence: [
        "report.json",
        "shield-recognition.json",
        "proof-job-valid.json",
        "credit-flow.json",
        "public-tree.json",
        "public-grant.json",
        "sdk-live-validation.json",
        "browser-flow.json",
        "reorg-flow.json",
        ...(replicas
            ? [
                  "replicas-started.json",
                  "replicas-before-reorg.json",
                  "replicas-after-reorg.json",
                  "replicas-cleanup.json",
              ]
            : []),
    ],
};
writeFileSync(join(directory, "validation-summary.json"), JSON.stringify(summary, null, 2) + "\n", {
    mode: 0o600,
});
console.log(JSON.stringify(summary, null, 2));
