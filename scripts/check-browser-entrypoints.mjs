/** Build public and neutral entries with real browser resolution and lazy backend chunks. */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { resolve } from "node:path";
// IPP HTTP/types must remain usable without wallet state or a proving dependency graph.
const ipp = await build({
    entryPoints: ["packages/ipp/src/index.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
});
assert(
    !Object.keys(ipp.metafile.inputs).some((path) =>
        /packages\/(?:prover|session)\/|packages\/sdk\/src\/(?:transactions|notes|client)\/|@aztec|@noir|node:/.test(
            path
        )
    ),
    "lightweight IPP entry acquired transaction, wallet-state or proving dependencies"
);
console.log(
    `IPP browser entry PASS: ${ipp.outputFiles[0].contents.length} bytes; no wallet/prover dependencies`
);

const result = await build({
    stdin: {
        contents:
            'export * from "./packages/sdk/dist/index.js"; export * from "./packages/prover/dist/index.js";',
        resolveDir: process.cwd(),
        sourcefile: "capability-entry.ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    splitting: true,
    write: false,
    outdir: resolve(".unused-browser-output"),
    metafile: true,
    logLevel: "silent",
});
const entryPair = Object.entries(result.metafile.outputs).find(
    ([, output]) => output.entryPoint === "capability-entry.ts"
);
const entry = entryPair?.[1];
assert(entry, "missing browser entry");
assert(!entry.exports.includes("WalletDiscovery"), "browser entry exposes standalone discovery");
const seen = new Set();
function eagerBytes(path) {
    if (seen.has(path)) return 0;
    seen.add(path);
    const output = result.metafile.outputs[path];
    assert(output, "missing browser chunk");
    return (
        output.bytes +
        output.imports
            .filter((item) => !item.external && item.kind !== "dynamic-import")
            .reduce((total, item) => total + eagerBytes(item.path), 0)
    );
}
const eager = eagerBytes(entryPair[0]);
const eagerInputs = [...seen].flatMap((path) => Object.keys(result.metafile.outputs[path].inputs));
assert(
    !eagerInputs.some((path) => path.includes("/@aztec-foundation/bb.js/")),
    "public entry eagerly imports the proving runtime"
);
assert(eager < 1024 * 1024, `public entry eagerly includes heavy backend assets (${eager} bytes)`);
assert(
    !Object.keys(result.metafile.inputs).some((path) => path.includes("/dest/node/")),
    "native backend entered browser graph"
);
assert(
    !Object.keys(result.metafile.inputs).some((path) =>
        /packages\/session\/|WalletSession|WalletStore/.test(path)
    ),
    "stateless browser entry acquired managed wallet state"
);
const prover = await build({
    entryPoints: ["packages/prover/src/index.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    write: false,
    metafile: true,
    logLevel: "silent",
});
assert(
    !Object.keys(prover.metafile.inputs).some((path) =>
        /backend-|circuits|noir|bb\.js|node:/.test(path)
    ),
    "neutral prover entry acquired execution resources"
);
console.log(
    `Browser entry PASS: ${eager} eager bytes; neutral prover ${prover.outputFiles[0].contents.length} bytes; no native inputs`
);
const storage = await build({
    entryPoints: ["packages/session/src/index.ts", "packages/session/src/storage/indexeddb.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    splitting: true,
    outdir: resolve(".unused-storage-output"),
    write: false,
    metafile: true,
    logLevel: "silent",
});
assert(
    !Object.keys(storage.metafile.inputs).some((path) => /\/dest\/node\/|\/sqlite\./.test(path)),
    "browser storage entry acquired native database code"
);
console.log("Browser storage imports PASS: no SQLite/native backend");

const ethersAdapter = await build({
    entryPoints: ["packages/sdk/src/integrations/ethers.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    splitting: true,
    outdir: resolve(".unused-ethers-output"),
    write: false,
    metafile: true,
    logLevel: "silent",
});
assert(
    !Object.keys(ethersAdapter.metafile.inputs).some((path) =>
        /backend-|circuits|noir|bb\.js|node:/.test(path)
    ),
    "ethers adapter acquired a proving or native backend"
);
console.log("Browser ethers imports PASS: no keys, native backend or proving resources");

assert(
    !Object.keys(result.metafile.inputs).some((path) =>
        /packages\/tree\/|\/Synchronizer\./.test(path)
    ),
    "public browser entry acquired public scanning or tree infrastructure"
);

const rpc = await build({
    entryPoints: ["packages/rpc/src/index.ts"],
    bundle: true,
    platform: "browser",
    format: "esm",
    splitting: true,
    outdir: resolve(".unused-rpc-output"),
    write: false,
    metafile: true,
    logLevel: "silent",
});
assert(
    !Object.keys(rpc.metafile.inputs).some((path) =>
        /\/packages\/(wallet|adapters|tree)\/|node:/.test(path)
    ),
    "RPC client acquired wallet storage or native adapters"
);
console.log("Protocol RPC browser imports PASS: no wallet storage/native adapters");
