/** Synchronize all protocol-owned assets from one explicitly selected checkout/release. */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const protocol = resolve(process.argv[2] ?? "../invisi-protocol");
for (const script of [
    "scripts/sync-protocol-abis.mjs",
    "packages/prover/scripts/sync-circuits.mjs",
    "packages/protocol/scripts/sync-witness-layouts.mjs",
]) {
    execFileSync(process.execPath, [script, protocol], { stdio: "inherit" });
}
