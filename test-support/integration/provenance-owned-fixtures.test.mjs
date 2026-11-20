import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { provisionOwnedScreeningFixture } from "./provenance-owned-fixtures.mjs";
test("owned acceptance provisions an explicit synthetic list without overwriting an existing policy", (t) => {
    const dir = mkdtempSync(join(tmpdir(), "owned-screening-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    provisionOwnedScreeningFixture(dir);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "address-list.json"))), {
        version: "1",
        dataVersion: "owned-synthetic-e2e-v1",
        denyAddresses: [],
    });
    assert.throws(() => provisionOwnedScreeningFixture(dir), /EEXIST/);
});
