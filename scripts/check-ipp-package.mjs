/** Verify the actual npm archive in a consumer that has no full SDK installed. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "invisi-ipp-package-"));
const pnpm = (...args) =>
    execFileSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
try {
    pnpm("--dir", "packages/primitives", "pack", "--pack-destination", temporary);
    pnpm("--dir", "packages/ipp", "pack", "--pack-destination", temporary);
    const archives = readdirSync(temporary).filter((name) => name.endsWith(".tgz"));
    const dependencies = {};
    for (const name of archives) {
        const path = join(temporary, name);
        const manifest = JSON.parse(
            execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" })
        );
        dependencies[manifest.name] = `file:${path}`;
        if (manifest.name === "@invisi-labs/ipp") {
            assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./invisi"]);
            assert.deepEqual(Object.keys(manifest.dependencies), ["@invisi-labs/primitives"]);
            assert.equal(manifest.peerDependenciesMeta["@invisi-labs/sdk"].optional, true);
            assert(
                !JSON.stringify(manifest).includes("workspace:"),
                "npm archive retains workspace references"
            );
        }
    }
    assert.equal(archives.length, 2);
    writeFileSync(
        join(temporary, "package.json"),
        JSON.stringify({
            private: true,
            packageManager: JSON.parse(readFileSync("package.json", "utf8")).packageManager,
            type: "module",
            dependencies,
            pnpm: { overrides: dependencies },
        })
    );
    execFileSync("pnpm", ["install", "--offline", "--ignore-scripts", "--lockfile=false"], {
        cwd: temporary,
        encoding: "utf8",
        stdio: "pipe",
    });
    const consumerRequire = createRequire(join(temporary, "probe.cjs"));
    assert.throws(() => consumerRequire.resolve("@invisi-labs/sdk"), { code: "MODULE_NOT_FOUND" });
    const cjs = consumerRequire("@invisi-labs/ipp");
    assert.equal(typeof cjs.IppClient, "function");
    writeFileSync(
        join(temporary, "probe.mjs"),
        'import { IppClient } from "@invisi-labs/ipp"; if (typeof IppClient !== "function") throw Error("Missing ESM export");'
    );
    execFileSync(process.execPath, [join(temporary, "probe.mjs")], {
        cwd: temporary,
        stdio: "pipe",
    });
    writeFileSync(
        join(temporary, "imports.ts"),
        'import * as ipp from "@invisi-labs/ipp"; const client: typeof ipp.IppClient = ipp.IppClient; void client;'
    );
    writeFileSync(
        join(temporary, "tsconfig.json"),
        JSON.stringify({
            compilerOptions: {
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                strict: true,
                noEmit: true,
                skipLibCheck: false,
                lib: ["ES2022", "DOM", "DOM.Iterable"],
                types: [],
            },
            include: ["imports.ts"],
        })
    );
    execFileSync(
        process.execPath,
        [resolve("node_modules/typescript/bin/tsc"), "--project", join(temporary, "tsconfig.json")],
        {
            cwd: temporary,
            stdio: "pipe",
        }
    );
    console.log("IPP packed consumer PASS: ESM, CommonJS and TypeScript without SDK installed");
} catch (error) {
    if (error.stdout) console.error(String(error.stdout));
    if (error.stderr) console.error(String(error.stderr));
    throw error;
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
