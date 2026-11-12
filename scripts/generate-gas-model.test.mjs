import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
for (const [name, remove] of [
    ["Shield fee", (r) => r.shape.kind === "shield" && r.shape.fee],
    ["create fee", (r) => r.shape.kind === "create-credit" && r.shape.fee],
    ["update fee", (r) => r.shape.kind === "update-credit" && r.shape.fee],
    ["revoke EOA", (r) => r.shape.kind === "revoke-credit" && r.shape.authorization === "eoa"],
    ["draw endpoint", (r) => r.shape.kind === "draw-credit" && r.shape.creditInputs === 80],
])
    test("rejects incomplete receipt catalog: " + name, () => {
        const data = JSON.parse(
            readFileSync(join(root, "packages/protocol/src/gas/data/measured-model.json"))
        );
        const directory = mkdtempSync(join(tmpdir(), "invisi-gas-incomplete-"));
        try {
            const paths = [0, 1, 2].map((i) => join(directory, i + ".json"));
            paths.forEach((path, i) =>
                writeFileSync(
                    path,
                    JSON.stringify({
                        commit: data.protocolCommit,
                        rows:
                            i === 0
                                ? data.rows
                                      .filter((r) => !remove(r))
                                      .map((r) => ({
                                          ...r,
                                          samples: [r.gasUnits, r.gasUnits, r.gasUnits],
                                      }))
                                : [],
                    })
                )
            );
            const result = spawnSync(
                process.execPath,
                [join(root, "scripts/generate-gas-model.mjs"), ...paths],
                { cwd: root, encoding: "utf8" }
            );
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /Missing (Shield|lifecycle|revocation|draw)/);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });
