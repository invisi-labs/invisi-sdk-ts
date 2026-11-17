/** Check runtime splitting using the same browser resolver used by consuming applications. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";

const result = await build({
    entryPoints: [
        "packages/prover/dist/index.js",
        "packages/prover/dist/wasm.js",
        "packages/prover/dist/provenance.js",
    ],
    bundle: true,
    platform: "browser",
    format: "esm",
    splitting: true,
    write: false,
    outdir: resolve(".unused-wasm-output"),
    metafile: true,
    loader: { ".wasm": "file" },
    logLevel: "silent",
});
const outputs = result.metafile.outputs;
const runtime = /\/(?:@aztec-foundation\/bb\.js|@noir-lang\/(?:noir_js|acvm_js|noirc_abi))\//;
for (const entry of [
    "packages/prover/dist/index.js",
    "packages/prover/dist/wasm.js",
    "packages/prover/dist/provenance.js",
]) {
    const path = Object.keys(outputs).find((path) => outputs[path].entryPoint === entry);
    assert(path, `Missing browser entry: ${entry}`);
    const seen = new Set();
    function visit(path) {
        if (seen.has(path)) return;
        seen.add(path);
        const output = outputs[path];
        assert(output, `Missing output chunk: ${path}`);
        for (const item of output.imports) {
            if (!item.external && item.kind !== "dynamic-import") visit(item.path);
        }
    }
    visit(path);
    const inputs = [...seen].flatMap((path) => Object.keys(outputs[path].inputs));
    assert(
        !inputs.some((path) => runtime.test(path)),
        `${entry} eagerly imports a proving runtime`
    );
    assert(!inputs.some((path) => path.endsWith(".wasm")), `${entry} eagerly imports WASM bytes`);
    const bytes = [...seen].reduce((sum, path) => sum + outputs[path].bytes, 0);
    console.log(`${entry}: ${bytes} eager bytes; no eager Noir or BB runtime`);
}
const inputs = Object.keys(result.metafile.inputs);
assert(
    inputs.some((path) => path.includes("/@aztec-foundation/bb.js/")),
    "Missing lazy BB runtime"
);
assert(
    inputs.some((path) => path.includes("/@noir-lang/noir_js/")),
    "Missing lazy Noir runtime"
);
assert(
    !inputs.some((path) => /\/dest\/node(?:-cjs)?\/|node:/.test(path)),
    "Node runtime in browser graph"
);
console.log("WASM loading check passed; runtime chunks remain available on demand");
