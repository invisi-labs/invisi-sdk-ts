import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = "packages/prover/provenance";
const check = (path) =>
    spawnSync("python3", ["scripts/sync-provenance.py", "--check-package", path], {
        encoding: "utf8",
    });
test("all seven provisioned Source tiers match the pinned public release", () => {
    const result = check(source);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /14 public artifacts\/VKs/);
});
test("release verification rejects altered artifacts and unexpected files", () => {
    const directory = mkdtempSync(join(tmpdir(), "invisi-source-assets-"));
    try {
        cpSync(source, directory, { recursive: true });
        const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"));
        const artifact = join(directory, manifest.circuits[0].artifact);
        const original = readFileSync(artifact);
        writeFileSync(artifact, Buffer.concat([original, Buffer.from("\n")]));
        const changed = check(directory);
        assert.notEqual(changed.status, 0);
        assert.match(changed.stderr, /artifact integrity mismatch/);
        writeFileSync(artifact, original);
        writeFileSync(join(directory, "unexpected-witness.json"), "{}");
        const extra = check(directory);
        assert.notEqual(extra.status, 0);
        assert.match(extra.stderr, /asset inventory/);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
