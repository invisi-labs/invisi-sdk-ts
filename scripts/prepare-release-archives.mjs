/** Build an immutable checksum inventory from already built, locally version-validated packages. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { archiveIntegrity } from "./release-archive.mjs";
const [tag, target] = process.argv.slice(2);
assert(
    /^v\d+\.\d+\.\d+$/.test(tag) && target,
    "Usage: prepare-release-archives.mjs vX.Y.Z EMPTY_OUTPUT_DIRECTORY"
);
execFileSync(process.execPath, ["scripts/check-release.mjs", tag], { stdio: "inherit" });
const output = resolve(target);
mkdirSync(output, { recursive: true });
assert.equal(readdirSync(output).length, 0, "Canonical archive destination must be empty");
const packages = [];
for (const directory of readdirSync("packages").sort()) {
    const manifest = JSON.parse(readFileSync(join("packages", directory, "package.json"), "utf8"));
    if (manifest.private) continue;
    execFileSync(
        "pnpm",
        ["--dir", join("packages", directory), "pack", "--pack-destination", output],
        { stdio: "pipe" }
    );
    const filename = `invisi-labs-${directory}-${tag.slice(1)}.tgz`;
    const path = join(output, filename);
    const packed = JSON.parse(
        execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" })
    );
    assert.equal(packed.name, manifest.name);
    assert.equal(packed.version, tag.slice(1));
    packages.push({
        name: packed.name,
        version: packed.version,
        filename,
        integrity: archiveIntegrity(path),
    });
}
writeFileSync(
    join(output, "npm-integrity.json"),
    JSON.stringify(
        {
            format: "invisi.npm.release-integrity.v1",
            version: tag.slice(1),
            archives: "github-release",
            packages,
        },
        null,
        2
    ) + "\n",
    { flag: "wx" }
);
console.log(
    `Prepared ${packages.length} canonical ${tag} archives and SHA-512 inventory; nothing published.`
);
