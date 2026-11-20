/** Verify the actual npm archive in a consumer outside the workspace. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const root = process.cwd();
const temporary = mkdtempSync(join(tmpdir(), "invisi-payment-router-package-"));
const pnpm = (...args) =>
    execFileSync("pnpm", args, { cwd: root, encoding: "utf8", stdio: "pipe" });
try {
    for (const name of ["primitives", "protocol", "prover", "rpc", "sdk", "payment-router"])
        pnpm("--dir", `packages/${name}`, "pack", "--pack-destination", temporary);
    const archives = readdirSync(temporary).filter((name) => name.endsWith(".tgz"));
    const dependencies = {};
    for (const name of archives) {
        const path = join(temporary, name);
        const manifest = JSON.parse(
            execFileSync("tar", ["-xOf", path, "package/package.json"], { encoding: "utf8" })
        );
        dependencies[manifest.name] = `file:${path}`;
        assert(
            !JSON.stringify(manifest).includes("workspace:"),
            "npm archive retains workspace references"
        );
        if (manifest.name === "@invisi-labs/payment-router")
            assert.deepEqual(Object.keys(manifest.exports), ["."]);
    }
    assert.equal(archives.length, 6);
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
    for (const name of ["@invisi-labs/session", "@invisi-labs/react", "@invisi-labs/vue"])
        assert.throws(() => consumerRequire.resolve(name), { code: "MODULE_NOT_FOUND" });
    const cjs = consumerRequire("@invisi-labs/payment-router");
    assert.equal(typeof cjs.PaymentRouterClient, "function");
    writeFileSync(
        join(temporary, "probe.mjs"),
        'import { PaymentRouterClient } from "@invisi-labs/payment-router"; if (typeof PaymentRouterClient !== "function") throw Error("Missing ESM export");'
    );
    execFileSync(process.execPath, [join(temporary, "probe.mjs")], {
        cwd: temporary,
        stdio: "pipe",
    });
    writeFileSync(
        join(temporary, "imports.ts"),
        'import { PaymentRouterClient, UniswapV3Adapter, ZeroExAdapter, type SwapQuote } from "@invisi-labs/payment-router"; const client: typeof PaymentRouterClient = PaymentRouterClient; void [client, UniswapV3Adapter, ZeroExAdapter];'
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
    console.log(
        "Payment Router packed consumer PASS: ESM, CommonJS and TypeScript without Session installed"
    );
} catch (error) {
    if (error.stdout) console.error(String(error.stdout));
    if (error.stderr) console.error(String(error.stderr));
    throw error;
} finally {
    rmSync(temporary, { recursive: true, force: true });
}
