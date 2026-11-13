/** Reviewable current package and capability boundaries. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const entries = {
    "vue": ["."],
    "protocol": [".", "./contracts", "./note", "./credit", "./provenance"],
    "primitives": [".", "./address", "./note", "./credit"],
    "sdk": [".", "./ethers", "./session-support", "./note", "./credit", "./provenance"],
    "prover": [".", "./native", "./wasm", "./aggregate", "./provenance", "./provenance-witness"],
    "rpc": [".", "./provenance", "./broadcaster"],
    "react": ["."],
    "session": [".", "./sqlite", "./indexeddb", "./memory"],
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

const primitives = await import(resolve("packages/primitives/dist/index.js"));
const sdk = await import(resolve("packages/sdk/dist/index.js"));
const session = await import(resolve("packages/session/dist/index.js"));
const protocol = await import(resolve("packages/protocol/dist/index.js"));
const rpc = await import(resolve("packages/rpc/dist/index.js"));
function functions(api, names, label) {
    for (const name of names)
        assert.equal(typeof api[name], "function", `${label}.${name} missing`);
}
functions(
    primitives,
    [
        "Wallet",
        "ViewingCapability",
        "Detector",
        "Disclosure",
        "computeNoteCommitment",
        "computeCreditCommitment",
        "recoverCreditState",
    ],
    "primitives"
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
        "readChainFinality",
        "readTransactionConfirmation",
        "FinalityUnsupportedError",
        "FinalityInconsistentError",
    ],
    "sdk"
);
functions(session, ["WalletSession", "Operation", "EncryptedWalletCodec"], "session");
for (const method of ["quote", "submit", "cancel"])
    assert.equal(typeof sdk.BroadcasterClient.prototype[method], "function");
for (const target of [sdk.PreparedTransaction, session.Operation])
    for (const method of ["withBroadcaster", "submitBroadcaster", "cancelBroadcaster"])
        assert.equal(method in target.prototype, false, "relay execution belongs to the client");
functions(rpc, ["ProtocolRpcClient", "defineDeployment"], "rpc");
functions(
    protocol,
    [
        "registrationTypedData",
        "registrationDigest",
        "buildRegistrationCalldata",
        "readChainFinality",
        "readTransactionConfirmation",
        "FinalityUnsupportedError",
        "FinalityInconsistentError",
    ],
    "protocol"
);
assert(!existsSync("packages/primitives/dist/local.js"), "private wallet entry still built");
functions(primitives.Wallet, ["fromAddress"], "Wallet");
assert(!("LocalWallet" in primitives), "local execution leaked into business entry");
assert(!("WalletAuthorization" in primitives), "account signer leaked into business entry");
assert(
    !("signWalletAuthorization" in primitives),
    "private account signing leaked into business entry"
);
assert(!("fromPrivateKey" in primitives.Wallet), "public wallet acquired private key restoration");
for (const name of ["getViewer", "getDetector", "exportAuthorization"])
    assert(
        !(name in primitives.Wallet.prototype),
        `public wallet acquired secret capability: ${name}`
    );
functions(primitives, ["prepareWalletRequest", "acceptWalletResponse"], "primitives");
functions(sdk.Protocol, ["fromRpc"], "Protocol");
functions(sdk.Protocol.prototype, ["forToken", "aggregate"], "Protocol");
functions(rpc.ProtocolRpcClient, ["getChains"], "ProtocolRpcClient");
functions(
    rpc.ProtocolRpcClient.prototype,
    ["getDeployment", "getNote", "getCreditState", "getNoteUpdates", "getCreditTransitions"],
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
            "getConfirmation",
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
    rpcManifest.dependencies["@invisi-labs/protocol"] === "workspace:*",
    "RPC must share pure public protocol contracts"
);
console.log("Current public surface PASS: explicit package entries and capability boundaries");
await import("./check-session-boundary.mjs");
