/** Run the reproducible real-verifier receipt matrix in an owned protocol scratch directory. */
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
const sdk = resolve(import.meta.dirname, ".."),
    protocol = resolve(process.argv[2] ?? join(sdk, "../invisi-protocol"));
assert.equal(
    execFileSync("git", ["branch", "--show-current"], { cwd: protocol, encoding: "utf8" }).trim(),
    "develop"
);
assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: protocol, encoding: "utf8" }).trim(),
    "",
    "Protocol worktree must be clean"
);
const directory = join(protocol, ".tools", "sdk-gas-" + Date.now());
mkdirSync(directory, { recursive: true });
for (const file of ["measure-notes.mjs", "measure-credit.mjs"])
    copyFileSync(join(sdk, "test-support/gas-benchmark", file), join(directory, file));
function run(command, args, cwd) {
    const result = spawnSync(command, args, { cwd, stdio: "inherit", env: process.env });
    assert.equal(result.status, 0, command + " failed");
}
run("forge", ["build", "--deny", "warnings", "--no-lint"], protocol);
run(process.execPath, [join(directory, "measure-notes.mjs")], protocol);
run(process.execPath, [join(directory, "measure-notes.mjs"), "--controls"], protocol);
run(process.execPath, [join(directory, "measure-credit.mjs")], protocol);
const reports = readdirSync(directory)
    .filter((name) => /^(notes|controls|credit)-\d+$/.test(name))
    .map((name) => join(directory, name, "report.json"));
assert.equal(reports.length, 3);
run(process.execPath, [join(sdk, "scripts/generate-gas-model.mjs"), ...reports], sdk);
console.log("Measurement evidence:", directory);
