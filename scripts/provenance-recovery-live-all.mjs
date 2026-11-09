import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
if (process.env.INVISI_PROVENANCE_LIVE !== "1" || !process.env.INVISI_PROVENANCE_TRUST)
    throw Error("Explicit LIVE=1 and public trust file are required");
const fixture = JSON.parse(readFileSync(process.env.INVISI_PROVENANCE_TRUST, "utf8"));
if (!fixture.recovery) throw Error("Missing public recovery dataset");
const lab = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const report = {
    format: "invisi-provenance-sdk-recovery-live-v1",
    startedAt: new Date().toISOString(),
    manifestSha256: fixture.manifestSha256,
    scope: fixture.scope,
    transactionHash: fixture.recovery.transactionHash,
    realHTTP: true,
    realPrimary: true,
    realNativeProofVerification: true,
    openingMaterial: false,
    mocks: false,
    cases: [],
};
for (const [sdk, cmd, args, cwd, file] of [
    [
        "typescript",
        "pnpm",
        [
            "--filter",
            "@invisi-labs/core",
            "exec",
            "vitest",
            "run",
            "src/provenance/recovery-live.test.ts",
        ],
        join(lab, "invisi-sdk-ts"),
        "sdk-recovery-ts-validation.json",
    ],
    [
        "go",
        "go",
        ["test", "-race", "-count=1", "-run", "^TestProvenanceRecoveryLive$", "-v", "./provenance"],
        join(lab, "invisi-sdk-go"),
        "sdk-recovery-go-validation.json",
    ],
    [
        "rust",
        "cargo",
        ["test", "--features", "sqlite", "--test", "provenance_recovery_live", "--", "--nocapture"],
        join(lab, "invisi-sdk-rust"),
        "sdk-recovery-rust-validation.json",
    ],
]) {
    const started = Date.now();
    console.log(`LIVE RECOVERY ${sdk}`);
    const result = spawnSync(cmd, args, {
        cwd,
        env: { ...process.env, INVISI_PROVENANCE_RECOVERY_LIVE: "1" },
        stdio: "inherit",
        timeout: 180000,
    });
    let evidence;
    try {
        evidence = JSON.parse(
            readFileSync(join(dirname(process.env.INVISI_PROVENANCE_TRUST), file), "utf8")
        );
    } catch {}
    report.cases.push({
        sdk,
        exitCode: result.status,
        elapsedMilliseconds: Date.now() - started,
        evidence,
    });
    if (result.status !== 0) {
        report.error = `${sdk} live recovery failed`;
        report.completedAt = new Date().toISOString();
        writeFileSync(
            join(dirname(process.env.INVISI_PROVENANCE_TRUST), "sdk-recovery-live-validation.json"),
            JSON.stringify(report, null, 2) + "\n"
        );
        throw Error(report.error);
    }
}
report.complete = true;
report.completedAt = new Date().toISOString();
writeFileSync(
    join(dirname(process.env.INVISI_PROVENANCE_TRUST), "sdk-recovery-live-validation.json"),
    JSON.stringify(report, null, 2) + "\n"
);
