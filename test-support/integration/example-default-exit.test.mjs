import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("scheduled cancellation requires explicit execution before reading host secrets", () => {
    const env = { ...process.env };
    for (const key of ["STORE_ENCRYPTION_KEY_HEX", "ALICE_PRIVATE_KEY", "WALLET_DB"])
        delete env[key];
    const result = spawnSync(
        "pnpm",
        ["--dir", "examples", "exec", "tsx", "07-broadcaster/04-scheduled-cancel-recovery.ts"],
        {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            env,
            encoding: "utf8",
            timeout: 15_000,
        }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--execute/);
    assert.doesNotMatch(result.stderr, /host-managed|PRIVATE_KEY|fetch failed/);
});
