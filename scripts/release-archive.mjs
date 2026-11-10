import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const archiveIntegrity = (filename) =>
    `sha512-${createHash("sha512").update(readFileSync(filename)).digest("base64")}`;
export function canonicalReleaseEntry(document, name, version) {
    assert.equal(document.format, "invisi.npm.release-integrity.v1");
    assert.equal(document.version, version, "Canonical release version mismatch");
    const entries = document.packages.filter((entry) => entry.name === name);
    assert.equal(entries.length, 1, "Missing or duplicate canonical release package");
    const entry = entries[0];
    assert.equal(entry.version, version);
    assert(/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity), "Invalid canonical SHA-512");
    return entry;
}
export function assertNewPublication(integrity, canonical) {
    assert(
        !canonical.publicationAccepted,
        "A previously accepted publication is not yet visible; wait without republishing"
    );
    assert.equal(
        integrity,
        canonical.integrity,
        "New publication archive differs from canonical release integrity"
    );
}
function extract(archive, directory) {
    const names = execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n");
    assert(
        names.every(
            (name) =>
                (name === "package" || name.startsWith("package/")) &&
                !name.split("/").includes("..")
        ),
        "Unsafe archive path"
    );
    const types = execFileSync("tar", ["-tvf", archive], { encoding: "utf8" }).trim().split("\n");
    assert(
        types.every((line) => /^[d-]/.test(line)),
        "Archive contains links or special files"
    );
    mkdirSync(directory);
    execFileSync("tar", ["-xzf", archive, "-C", directory]);
}
function files(directory, prefix = "") {
    return readdirSync(directory)
        .flatMap((name) => {
            const relative = prefix + name,
                path = join(directory, name),
                info = lstatSync(path);
            assert(!info.isSymbolicLink(), "Unexpected archive symlink");
            return info.isDirectory() ? files(path, relative + "/") : [relative];
        })
        .sort();
}
function packageMetadata(bytes) {
    const value = JSON.parse(bytes.toString());
    const dependencyMaps = new Set([
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
    ]);
    return JSON.stringify(
        Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => {
                    const entry = value[key];
                    return [
                        key,
                        dependencyMaps.has(key)
                            ? Object.fromEntries(
                                  Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))
                              )
                            : entry,
                    ];
                })
        )
    );
}
function sourcemap(bytes, packageName) {
    const result = JSON.parse(bytes.toString());
    const suffix = new RegExp(`[/\\\\]packages[/\\\\]${packageName}[/\\\\]dist[/\\\\](.+)$`);
    const normalize = (path) => {
        if (typeof path !== "string" || !/^(?:\/|[A-Za-z]:\\)/.test(path)) return path;
        const match = suffix.exec(path);
        return match ? `packages/${packageName}/dist/${match[1].replaceAll("\\", "/")}` : path;
    };
    if ("file" in result) result.file = normalize(result.file);
    if (Array.isArray(result.sources)) result.sources = result.sources.map(normalize);
    return result;
}
/** Preserve immutable published metadata while requiring identical code, declarations and resources. */
export function compareReleaseArchives(built, canonical, packageName) {
    const root = mkdtempSync(join(tmpdir(), "invisi-release-compare-"));
    try {
        const left = join(root, "built"),
            right = join(root, "canonical");
        extract(built, left);
        extract(canonical, right);
        const inventory = files(left);
        assert.deepEqual(inventory, files(right), "Release archive file inventory differs");
        const metadataDifferences = [];
        for (const path of inventory) {
            const a = readFileSync(join(left, path)),
                b = readFileSync(join(right, path));
            if (a.equals(b)) continue;
            if (path === "package/package.json") {
                assert.equal(
                    packageMetadata(a),
                    packageMetadata(b),
                    "Package metadata values or condition order differ"
                );
                metadataDifferences.push(`${path}: JSON property order/formatting`);
            } else if (path.endsWith(".cjs.map")) {
                assert.deepEqual(
                    sourcemap(a, packageName),
                    sourcemap(b, packageName),
                    `${path}: sourcemap content differs`
                );
                metadataDifferences.push(`${path}: absolute build directory metadata`);
            } else assert.fail(`${path}: runtime/declaration/resource bytes differ`);
        }
        return metadataDifferences;
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}
