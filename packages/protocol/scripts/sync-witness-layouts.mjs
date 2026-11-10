/** Generate local witness schemas only from authenticated current protocol releases. */
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(process.argv[2] ?? "../invisi-protocol");
const json = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const sha = (data) => createHash("sha256").update(data).digest("hex");
const layouts = {};
for (const path of ["circuits/transact/manifest.json", "circuits/credit/manifest.json"]) {
    const manifest = json(path);
    if (!manifest.complete) throw new Error("incomplete circuit release");
    for (const [path, hash] of Object.entries(manifest.dependencies))
        if (sha(readFileSync(resolve(root, path))) !== hash)
            throw new Error("stale circuit dependency: " + path);
    for (const entry of [...(manifest.entries ?? [manifest]), ...(manifest.aggregates ?? [])]) {
        const artifact = json(entry.artifact);
        if (
            sha(
                JSON.stringify({
                    noirVersion: artifact.noir_version,
                    abi: artifact.abi,
                    bytecode: artifact.bytecode,
                })
            ) !== entry.artifactSha256
        )
            throw new Error("unauthenticated circuit artifact");
        const keys = Object.fromEntries(
            [entry.direct ?? entry, entry.recursive]
                .filter(Boolean)
                .map((key) => [key.target, key.vkSha256])
        );
        layouts[entry.name] = {
            artifactSha256: entry.artifactSha256,
            keys,
            publicInputCount: entry.publicInputCount,
            public: artifact.abi.parameters
                .filter((p) => p.visibility === "public")
                .map((p) => ({
                    name: p.name,
                    count: p.type.kind === "array" ? p.type.length : 1,
                    ...(p.type.kind === "array" ? { array: true } : {}),
                })),
            private: artifact.abi.parameters
                .filter((p) => p.visibility !== "public")
                .map((p) => p.name),
        };
    }
}
writeFileSync(
    new URL("../../prover/src/witness-layouts.json", import.meta.url),
    JSON.stringify(layouts, null, 2) + "\n"
);
console.log("Generated " + Object.keys(layouts).length + " authenticated witness layouts");
