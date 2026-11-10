import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    archiveIntegrity,
    assertNewPublication,
    canonicalReleaseEntry,
    compareReleaseArchives,
} from "./release-archive.mjs";
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
    const release = JSON.parse(
        readFileSync(
            new URL(`../releases/v${manifest.version}/npm-integrity.json`, import.meta.url),
            "utf8"
        )
    );
    const canonical = canonicalReleaseEntry(release, manifest.name, manifest.version);
    const integrity = archiveIntegrity(filename);
    const response = await fetch(
        `https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`,
        { signal: AbortSignal.timeout(30000) }
    );
    const metadata = response.status === 200 ? await response.json() : null;
    if (
        publicationState(
            response.status,
            metadata,
            canonical.integrity,
            manifest.name,
            manifest.version
        ) === "skip"
    ) {
        const directory = mkdtempSync(join(tmpdir(), "invisi-published-archive-"));
        try {
            const url = new URL(metadata.dist.tarball);
            assert(
                url.protocol === "https:" && url.hostname === "registry.npmjs.org",
                "Unexpected registry tarball origin"
            );
            console.log(`Downloading canonical archive ${manifest.name}@${manifest.version}`);
            const download = await fetch(url, { signal: AbortSignal.timeout(600000) });
            assert(download.ok, `Cannot download canonical archive: HTTP ${download.status}`);
            const published = join(directory, canonical.filename);
            assert(download.body, "Canonical archive response has no body");
            await pipeline(Readable.fromWeb(download.body), createWriteStream(published));
            assert.equal(
                archiveIntegrity(published),
                canonical.integrity,
                "Downloaded canonical archive SHA-512 mismatch"
            );
            const differences = compareReleaseArchives(
                filename,
                published,
                manifest.name.slice(13)
            );
            for (const difference of differences)
                console.log(`Frozen published metadata: ${difference}`);
            console.log(
                `Verified existing ${manifest.name}@${manifest.version}; canonical registry/download integrity and runtime/declaration/resource bytes match; no republish`
            );
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
        return;
    }
    assertNewPublication(integrity, canonical);
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
