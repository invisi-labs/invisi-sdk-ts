import test from "node:test";
import assert from "node:assert/strict";
import { recoveryFixture } from "./provenance-e2e-recovery.mjs";
test("recovery refuses a protocol-only root before querying the chain", async () => {
    await assert.rejects(
        recoveryFixture({
            root: "/protocol-only",
            runtime: {
                rpc: async () => {
                    throw Error("queried chain with unvalidated resources");
                },
            },
        }),
        /Periphery resource root required/
    );
});
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
test("recovery authenticates an explicit independent Periphery root before chain checks", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "periphery-recovery-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const manifest = Buffer.from("{}");
    mkdirSync(join(dir, "circuits/provenance"), { recursive: true });
    writeFileSync(join(dir, "circuits/provenance/manifest.json"), manifest);
    const options = {
        peripheryRoot: dir,
        sourceBundle: { manifestSha256: createHash("sha256").update(manifest).digest("hex") },
        privateReceipt: { transactionHash: "0x01" },
        runtime: {
            rpc: async () => {
                throw Error("reached chain authentication");
            },
        },
    };
    await assert.rejects(recoveryFixture(options), /reached chain authentication/);
    await assert.rejects(
        recoveryFixture({ ...options, sourceBundle: { manifestSha256: "0".repeat(64) } }),
        /recovery manifest mismatch/
    );
});
