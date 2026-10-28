import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function validateRelease(tag, packages, { packed = false } = {}) {
    assert(
        typeof tag === "string" && /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag),
        "Release tag must be vX.Y.Z with a canonical stable version"
    );
    assert(packages.length > 0, "No release packages found");
    const version = tag.slice(1);
    const names = new Set();
    for (const manifest of packages) {
        assert(!manifest.private, `${manifest.name}: private package in release`);
        assert(!names.has(manifest.name), `${manifest.name}: duplicate release package`);
        names.add(manifest.name);
        assert.equal(manifest.version, version, `${manifest.name}: version must equal ${version}`);
    }
    for (const manifest of packages) {
        for (const section of [
            "dependencies",
            "optionalDependencies",
            "peerDependencies",
            "devDependencies",
        ]) {
            for (const [name, range] of Object.entries(manifest[section] ?? {})) {
                if (!name.startsWith("@invisi-labs/")) continue;
                assert(names.has(name), `${manifest.name}: unknown internal dependency ${name}`);
                const allowed = packed
                    ? [version]
                    : [version, "workspace:*", `workspace:${version}`];
                assert(
                    allowed.includes(range),
                    `${manifest.name}: ${section} dependency ${name} must resolve exactly to ${version}; got ${range}`
                );
            }
        }
    }
}

function main() {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];
    const packages = readdirSync(resolve(root, "packages"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) =>
            JSON.parse(readFileSync(resolve(root, "packages", entry.name, "package.json"), "utf8"))
        );
    const config = JSON.parse(readFileSync(resolve(root, ".changeset/config.json"), "utf8"));
    const expected = config.fixed.flat().sort();
    assert.deepEqual(
        packages.map((manifest) => manifest.name).sort(),
        expected,
        "Release packages must match the fixed version group"
    );
    validateRelease(tag, packages);

    const packedDirectory = process.argv[3];
    if (packedDirectory) {
        const packed = readdirSync(packedDirectory)
            .filter((name) => name.endsWith(".tgz"))
            .map((name) =>
                JSON.parse(
                    execFileSync(
                        "tar",
                        ["-xOf", resolve(packedDirectory, name), "package/package.json"],
                        { encoding: "utf8" }
                    )
                )
            );
        assert.deepEqual(
            packed.map((manifest) => manifest.name).sort(),
            expected,
            "Packed packages must match the complete release group"
        );
        validateRelease(tag, packed, { packed: true });
    }
    console.log(`Release check passed: ${packages.length} packages match ${tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main();
}
