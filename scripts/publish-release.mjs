import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function publicationState(status, metadata, integrity, name, version) {
    if (status === 404) return "publish";
    assert.equal(
        status,
        200,
        `Cannot inspect published ${name}@${version}: registry HTTP ${status}`
    );
    assert.equal(metadata?.name, name, "Published package name mismatch");
    assert.equal(metadata?.version, version, "Published package version mismatch");
    assert.equal(
        metadata?.dist?.integrity,
        integrity,
        `${name}@${version} already exists with different bytes`
    );
    return "skip";
}

async function main() {
    const filename = resolve(process.argv[2]);
    const manifest = JSON.parse(
        execFileSync("tar", ["-xOf", filename, "package/package.json"], { encoding: "utf8" })
    );
    assert(/^@invisi-labs\/[a-z]+$/.test(manifest.name), "Unexpected release package");
    assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "Invalid release version");
    const integrity = `sha512-${createHash("sha512").update(readFileSync(filename)).digest("base64")}`;
    const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`,
        { signal: AbortSignal.timeout(30000) }
    );
    const metadata = response.status === 200 ? await response.json() : null;
    if (
        publicationState(response.status, metadata, integrity, manifest.name, manifest.version) ===
        "skip"
    ) {
        console.log(
            `Verified existing ${manifest.name}@${manifest.version}; identical archive, no republish`
        );
        return;
    }
    execFileSync(
        "npm",
        [
            "publish",
            filename,
            "--access",
            "public",
            "--tag",
            "latest",
            "--registry=https://registry.npmjs.org",
        ],
        { stdio: "inherit" }
    );
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
    await main();
