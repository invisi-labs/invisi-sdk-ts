import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { validateRelease } from "./check-release.mjs";

const [tag, directory] = process.argv.slice(2);
assert(tag && directory, "Usage: node scripts/check-packed-release.mjs vX.Y.Z PACK_DIRECTORY");
const packDirectory = resolve(directory);
const archives = readdirSync(packDirectory).filter((name) => name.endsWith(".tgz"));
const packages = archives.map((name) => {
    const archive = join(packDirectory, name);
    const manifest = JSON.parse(
        execFileSync("tar", ["-xOf", archive, "package/package.json"], { encoding: "utf8" })
    );
    const files = new Set(
        execFileSync("tar", ["-tf", archive], { encoding: "utf8" }).trim().split("\n")
    );
    assert.equal(manifest.license, "Apache-2.0", `${manifest.name}: license metadata`);
    const license = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
    assert(
        license.includes("END OF TERMS AND CONDITIONS") && license.length > 10000,
        "Root LICENSE must contain the complete Apache-2.0 terms"
    );
    assert.equal(
        execFileSync("tar", ["-xOf", archive, "package/LICENSE"], { encoding: "utf8" }),
        license,
        `${manifest.name}: packaged LICENSE must contain the complete terms`
    );
    const entries = [];
    for (const [subpath, target] of Object.entries(manifest.exports)) {
        const conditions = typeof target === "string" ? { import: target } : target;
        for (const [condition, path] of Object.entries(conditions)) {
            assert(
                typeof path === "string" && path.startsWith("./"),
                `${manifest.name}: unsupported export ${subpath}`
            );
            assert(
                files.has(`package/${path.slice(2)}`),
                `${manifest.name}: missing ${condition} target ${path}`
            );
        }
        entries.push({
            specifier: manifest.name + (subpath === "." ? "" : subpath.slice(1)),
            conditions: Object.keys(conditions),
        });
    }
    return { archive, manifest, entries };
});
validateRelease(
    tag,
    packages.map((entry) => entry.manifest),
    { packed: true }
);
const expected = JSON.parse(readFileSync(".changeset/config.json", "utf8")).fixed.flat().sort();
assert.deepEqual(
    packages.map(({ manifest }) => manifest.name).sort(),
    expected,
    "The fixed release must contain every public package exactly once"
);
const consumer = mkdtempSync(join(tmpdir(), "invisi-packed-release-"));
const require = createRequire(import.meta.url);
const version = (name, location) =>
    JSON.parse(
        readFileSync(
            require.resolve(`${name}/package.json`, { paths: [resolve(location)] }),
            "utf8"
        )
    ).version;
const dependencies = Object.fromEntries(
    packages.map(({ archive, manifest }) => [manifest.name, `file:${archive}`])
);
Object.assign(dependencies, {
    react: version("react", "packages/react"),
    vue: version("vue", "packages/vue"),
    "@types/react": version("@types/react", "packages/react"),
    "@types/node": version("@types/node", "packages/sdk"),
    typescript: version("typescript", "."),
});
writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify(
        {
            name: "invisi-release-consumer",
            private: true,
            type: "module",
            dependencies,
            packageManager: JSON.parse(readFileSync("package.json", "utf8")).packageManager,
            pnpm: {
                overrides: Object.fromEntries(
                    packages.map(({ archive, manifest }) => [manifest.name, `file:${archive}`])
                ),
            },
        },
        null,
        2
    )
);
writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
        compilerOptions: {
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            noEmit: true,
            skipLibCheck: false,
            types: ["node"],
        },
        include: ["imports.ts"],
    })
);
const entries = packages.flatMap((entry) => entry.entries);
writeFileSync(
    join(consumer, "imports.ts"),
    entries
        .map(
            ({ specifier }, index) =>
                `import * as entry${index} from ${JSON.stringify(specifier)}; void entry${index};`
        )
        .join("\n")
);
writeFileSync(
    join(consumer, "verify.mjs"),
    `import {createRequire} from "node:module"; const require=createRequire(import.meta.url); const entries=${JSON.stringify(entries)}; for(const entry of entries){ if(entry.conditions.includes("import")) await import(entry.specifier); if(entry.conditions.includes("require")) require(entry.specifier); } console.log("Packed ESM/CJS imports passed:",entries.length);`
);
console.log(`Installing packed release into isolated consumer: ${consumer}`);
execFileSync(
    "pnpm",
    ["install", "--prefer-offline", "--ignore-scripts", "--config.auto-install-peers=false"],
    { cwd: consumer, stdio: "inherit" }
);
execFileSync(process.execPath, ["verify.mjs"], { cwd: consumer, stdio: "inherit" });
execFileSync("pnpm", ["exec", "tsc", "--project", "tsconfig.json"], {
    cwd: consumer,
    stdio: "inherit",
});
console.log(`Packed release consumer passed: ${packages.length} packages at ${tag.slice(1)}`);
