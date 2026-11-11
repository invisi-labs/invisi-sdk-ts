import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { archiveIntegrity, compareReleaseArchives } from "./release-archive.mjs";

const [tag, builtDirectory, canonicalDirectory] = process.argv.slice(2);
assert(/^v\d+\.\d+\.\d+$/.test(tag), "Invalid release tag");
const manifest = JSON.parse(readFileSync(`releases/${tag}/npm-integrity.json`, "utf8"));
if (manifest.archives === "github-release") {
    execFileSync(
        "gh",
        ["release", "download", tag, "--pattern", "*.tgz", "--dir", canonicalDirectory],
        {
            stdio: "inherit",
        }
    );
    for (const entry of manifest.packages) {
        assert.equal(entry.filename, `invisi-labs-${entry.name.slice(13)}-${tag.slice(1)}.tgz`);
        const canonical = resolve(join(canonicalDirectory, entry.filename));
        const built = resolve(join(builtDirectory, entry.filename));
        assert.equal(
            archiveIntegrity(canonical),
            entry.integrity,
            "Canonical archive SHA-512 mismatch"
        );
        compareReleaseArchives(built, canonical, entry.name.slice(13));
        copyFileSync(canonical, built);
    }
}
