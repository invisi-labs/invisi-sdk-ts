import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const catalogPath = "packages/sdk/src/gas/data/gas-benchmarks.json";
const bytes = readFileSync(catalogPath);
const profiles = JSON.parse(bytes);
const result = await build({
    entryPoints: ["packages/sdk/src/gas/gas-estimation.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    packages: "external",
    write: false,
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
    createRequire(new URL("../packages/sdk/package.json", import.meta.url)),
    module,
    module.exports
);
const cases = [];
for (const profile of profiles)
    for (const measurement of profile.measurements) {
        const request = {
            deployment: profile.deployment,
            shape: measurement.shape,
            circuit: measurement.circuit,
        };
        cases.push({
            id: measurement.id,
            request,
            gasUnits: module.exports.estimateShapeGas(request).gasUnits.toString(),
        });
        if (measurement.shape.kind.includes("credit")) {
            for (const variant of ["memo", "signature", "permit"]) {
                const shape = { ...measurement.shape };
                if (variant === "memo")
                    shape.deliveryBytes +=
                        256 *
                        Math.max(
                            1,
                            shape.noteOutputs + shape.creditOutputs + shape.creditRemainders
                        );
                if (variant === "signature") shape.funding = "signature";
                if (variant === "permit") shape.permit = true;
                const modeled = { ...request, shape };
                cases.push({
                    id: `${measurement.id}-${variant}`,
                    request: modeled,
                    gasUnits: module.exports.estimateShapeGas(modeled).gasUnits.toString(),
                });
            }
        }
    }
writeFileSync(
    "packages/sdk/src/gas/data/gas-reference-vectors.json",
    JSON.stringify(
        {
            tsCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            catalogSha256: createHash("sha256").update(bytes).digest("hex"),
            cases,
        },
        null,
        2
    ) + "\n"
);
console.log(`Generated ${cases.length} gas reference vectors`);
