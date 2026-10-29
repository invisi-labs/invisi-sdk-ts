import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { sourceIdentity, BenchmarkMerkleTree } from "./benchmark-gas-source.mjs";
test("content identity includes untracked executable sources and compiler settings", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "credit-gas-source-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "contracts/src/libraries"), { recursive: true });
    writeFileSync(join(dir, "foundry.toml"), 'solc="0.8.38"\n');
    const before = sourceIdentity(dir);
    writeFileSync(
        join(dir, "contracts/src/libraries/CreditPeriodLib.sol"),
        "library CreditPeriodLib {}\n"
    );
    const added = sourceIdentity(dir);
    assert.notEqual(before.sha256, added.sha256);
    assert(added.files["contracts/src/libraries/CreditPeriodLib.sol"]);
    writeFileSync(join(dir, "foundry.toml"), 'solc="0.8.39"\n');
    assert.notEqual(sourceIdentity(dir).sha256, added.sha256);
});
test("incremental Merkle cache reconstructs every proof without rehashing the full tree", async () => {
    const hash = async ([a, b]) => (a * 17n + b * 31n + 1n) % ((1n << 251n) - 9n),
        tree = await new BenchmarkMerkleTree(hash).initialize();
    for (let i = 1n; i <= 123n; i++) await tree.insert(i);
    for (let i = 0; i < 123; i++) {
        const m = tree.membership(i);
        let value = m.leaf,
            index = i;
        for (const sibling of m.path) {
            value = await hash(index & 1 ? [sibling, value] : [value, sibling]);
            index >>= 1;
        }
        assert.equal(value, m.root);
    }
    assert.throws(() => tree.membership(123));
});
