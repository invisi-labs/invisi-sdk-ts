/** Reviewable current package and capability boundaries. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const entries = {
    core: [".", "./address", "./note", "./credit"],
    protocol: [".", "./contracts", "./note", "./credit"],
    prover: [".", "./native", "./wasm", "./aggregate"],
    rpc: ["."],
    sdk: [".", "./ethers", "./session-support", "./note", "./credit"],
    session: [".", "./sqlite", "./indexeddb", "./memory"],
    react: ["."],
    vue: ["."],
};
const packages = readdirSync("packages").filter((name) =>
    existsSync(`packages/${name}/package.json`)
);
assert.deepEqual(
    packages.sort(),
    Object.keys(entries).sort(),
    "workspace package boundary changed"
);
for (const [name, paths] of Object.entries(entries)) {
    const manifest = JSON.parse(readFileSync(`packages/${name}/package.json`, "utf8"));
    assert.deepEqual(
        Object.keys(manifest.exports).sort(),
        [...paths].sort(),
        `public entries changed: ${name}`
    );
    for (const section of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
    ])
        for (const dep of Object.keys(manifest[section] ?? {}))
            if (dep.startsWith("@invisi-labs/"))
                assert(
                    Object.hasOwn(entries, dep.slice(13)),
                    `unrecognized workspace dependency: ${dep}`
                );
}

function checkExamples(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (["node_modules", "dist", ".turbo"].includes(entry.name)) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) checkExamples(path);
        else
            assert(
                !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name),
                `behavioral test belongs to a package: ${path}`
            );
    }
}
checkExamples("examples");
const examples = JSON.parse(readFileSync("examples/package.json", "utf8"));
assert(!examples.scripts.test, "examples use explicit smoke runs");
assert(!examples.devDependencies?.vitest, "test runtime belongs to packages");

const core = await import(resolve("packages/core/dist/index.js"));
const sdk = await import(resolve("packages/sdk/dist/index.js"));
const session = await import(resolve("packages/session/dist/index.js"));
const protocol = await import(resolve("packages/protocol/dist/index.js"));
const rpc = await import(resolve("packages/rpc/dist/index.js"));
function functions(api, names, label) {
    for (const name of names)
        assert.equal(typeof api[name], "function", `${label}.${name} missing`);
}
functions(
    core,
    [
        "Wallet",
        "PublicWallet",
        "ViewingCapability",
        "Detector",
        "Disclosure",
        "computeNoteCommitment",
        "computeCreditCommitment",
        "recoverCreditState",
    ],
    "core"
);
functions(
    sdk,
    [
        "Invisi",
        "Protocol",
        "AddressRegistry",
        "InvisiError",
        "NoteOutput",
        "PaymentNote",
        "PreparedTransaction",
        "RegistrationOperation",
    ],
    "sdk"
);
functions(session, ["WalletSession", "Operation", "EncryptedWalletCodec"], "session");
functions(rpc, ["ProtocolRpcClient", "defineDeployment"], "rpc");
functions(
    protocol,
    ["WitnessBuilder", "registrationTypedData", "registrationDigest", "buildRegistrationCalldata"],
    "protocol"
);
functions(core.Wallet, ["fromPrivateKey"], "Wallet");
functions(core.PublicWallet, ["fromAddress"], "PublicWallet");
functions(core.Wallet.prototype, ["getViewer", "getDetector", "exportAuthorization"], "Wallet");
// Public identities cannot decrypt or authorize spending.
for (const name of ["getViewer", "getDetector", "exportAuthorization"])
    assert(
        !(name in core.PublicWallet.prototype),
        `public wallet acquired secret capability: ${name}`
    );
functions(sdk.Protocol, ["fromRpc"], "Protocol");
functions(sdk.Protocol.prototype, ["forToken", "aggregate"], "Protocol");
functions(rpc.ProtocolRpcClient, ["getChains"], "ProtocolRpcClient");
functions(
    rpc.ProtocolRpcClient.prototype,
    [
        "getDeployment",
        "getNote",
        "getCreditState",
        "getNoteUpdates",
        "getCreditTransitions",
        "detectNotes",
        "detectCreditStates",
    ],
    "ProtocolRpcClient"
);
const preparations = [
    "prepareShield",
    "prepareTransfer",
    "prepareCreateCredit",
    "prepareDrawCredit",
    "prepareUpdateCredit",
    "prepareRevokeCredit",
];
functions(sdk.Invisi.prototype, [...preparations, "prepareRegistration"], "Invisi");
functions(
    session.WalletSession.prototype,
    [...preparations, "refresh", "balance", "resume", "sendTransaction"],
    "WalletSession"
);
for (const [name, entry] of [
    ["PreparedTransaction", sdk.PreparedTransaction],
    ["Operation", session.Operation],
])
    functions(
        entry.prototype,
        [
            "exportWalletAuthorization",
            "withWalletSignature",
            "exportFundingAuthorization",
            "withFundingSignature",
            "exportRevocationAuthorization",
            "withRevocationSignature",
        ],
        name
    );
functions(
    sdk.RegistrationOperation.prototype,
    ["exportRegistrationAuthorization", "withSignature", "authorizeDirect"],
    "RegistrationOperation"
);
const rpcManifest = JSON.parse(readFileSync("packages/rpc/package.json", "utf8"));
assert(
    !("@invisi-labs/protocol" in rpcManifest.dependencies),
    "transport must not depend on protocol execution"
);
console.log("Current public surface PASS: explicit package entries and capability boundaries");
await import("./check-session-boundary.mjs");
