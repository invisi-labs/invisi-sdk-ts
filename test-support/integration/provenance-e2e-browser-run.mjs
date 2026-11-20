import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    root as peripheryRoot,
    json,
} from "../../../invisi-periphery/scripts/provenance-build.mjs";
const root = resolve(peripheryRoot, "../invisi-core");
import { browserScenario } from "./provenance-e2e-browser.mjs";
// Recheck retained owned services without rebuilding the chain or replacing HTTP data.
const args = process.argv.slice(2),
    directory = resolve(args.find((a) => !a.startsWith("--")) ?? "");
assert(
    args.length >= 1 &&
        args.length <= 2 &&
        args.every((a) => !a.startsWith("--") || a === "--details"),
    "usage: node test-support/integration/provenance-e2e-browser-run.mjs <owned-run-directory> [--details]"
);
const services = JSON.parse(readFileSync(join(directory, "services.json"))),
    report = JSON.parse(readFileSync(join(directory, "report.json")));
assert.equal(new URL(services.provenanceRPC).hostname, "127.0.0.1");
const save = (name, value) => writeFileSync(join(directory, name), json(value), { mode: 0o600 });
const result = await browserScenario({
    root,
    serviceRoot: resolve(root, "../invisi-provenance"),
    serviceURL: services.provenanceRPC,
    report,
    save,
    step: console.log,
    skipExisting: args.includes("--details"),
});
save("browser-revalidation.json", {
    ...result,
    completedAt: new Date().toISOString(),
    realHTTP: true,
    mocks: false,
});
console.log("PASS real populated browser revalidation");
