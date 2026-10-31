/** Regression gate: public capability APIs only, with no obsolete transport package or alias. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
for (const name of [
    "ipp",
    "payer",
    "receiver",
    "node",
    "deployments",
    "tree",
    "contracts",
    "wallet",
    "adapters",
])
    assert(!existsSync(`packages/${name}/package.json`), `obsolete package remains: ${name}`);
for (const name of readdirSync("packages")) {
    const path = `packages/${name}/package.json`;
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const section of [
        "dependencies",
        "optionalDependencies",
        "peerDependencies",
        "devDependencies",
    ])
        for (const dep of Object.keys(manifest[section] ?? {}))
            assert(
                dep !== "viem" &&
                    !/^@invisi-labs\/(ipp|payer|receiver|node|deployments|tree|contracts|wallet|adapters)$/.test(
                        dep
                    ),
                `obsolete dependency in ${manifest.name}: ${dep}`
            );
}
// Examples teach public API usage. Behavioral tests belong to their owning packages.
function checkExampleDirectory(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (["node_modules", "dist", ".turbo"].includes(entry.name)) continue;
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) {
            checkExampleDirectory(path);
        } else {
            assert(
                !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name),
                `behavioral test inside examples: ${path}`
            );
        }
    }
}
checkExampleDirectory("examples");
const examples = JSON.parse(readFileSync("examples/package.json", "utf8"));
assert(!examples.scripts.test, "examples must use build/typecheck and explicit smoke runs");
assert(!examples.devDependencies?.vitest, "test runtime belongs to SDK packages");
const core = await import(resolve("packages/core/dist/index.js")),
    sdk = await import(resolve("packages/sdk/dist/index.js"));
for (const name of [
    "deriveWallet",
    "deriveWalletFromMnemonic",
    "encodeLongAddress",
    "encodeShortAddress",
])
    assert(!(name in core), `obsolete public function: ${name}`);
for (const name of [
    "IPPClient",
    "buildShieldFromRequest",
    "buildVoucher",
    "createPaymentRequest",
    "Synchronizer",
    "EthersEventSource",
    "CanonicalTreeProvider",
    "InMemoryMerkleTree",
    "InvisiTreeManager",
    "MerkleTreeSync",
    "WalletDiscovery",
])
    assert(!(name in sdk), `obsolete public API: ${name}`);
for (const name of [
    "Wallet",
    "Invisi",
    "WalletSession",
    "Protocol",
    "AddressRegistry",
    "InvisiError",
])
    assert.equal(typeof sdk[name], "function", `missing public object: ${name}`);
assert.equal(
    typeof sdk.Invisi.prototype.prepareRegistration,
    "function",
    "missing registry composition entry"
);
assert.equal(typeof core.Wallet.fromPrivateKey, "function", "missing account-key factory");
for (const name of ["fromSeed", "fromPhrase"]) {
    assert(!(name in core.Wallet), `obsolete HD factory: ${name}`);
}
assert(!("ReceivingAddress" in sdk), "low-level address object exposed by the SDK entry");
for (const name of ["getViewer", "getDetector"]) {
    assert.equal(
        typeof core.Wallet.prototype[name],
        "function",
        `missing capability getter: ${name}`
    );
}
for (const name of ["exportViewing", "exportDetection"]) {
    assert(!(name in core.Wallet.prototype), `obsolete capability export: ${name}`);
}
assert(!("defineDeployment" in sdk), "deployment parsing belongs to the RPC package");
assert(!("deployments" in sdk), "SDK must not keep a deployment catalog");
const rpc = await import(resolve("packages/rpc/dist/index.js"));
assert.equal(typeof rpc.ProtocolRpcClient.getChains, "function", "missing service chain discovery");
assert.equal(typeof rpc.defineDeployment, "function", "RPC deployment parser missing");
assert.equal(
    typeof rpc.ProtocolRpcClient.prototype.getDeployment,
    "function",
    "RPC deployment discovery missing"
);
const rpcManifest = JSON.parse(readFileSync(resolve("packages/rpc/package.json"), "utf8"));
assert(!("@invisi-labs/protocol" in rpcManifest.dependencies), "RPC must not depend on Protocol");
assert.equal(typeof sdk.Protocol.fromRpc, "function", "missing async RPC protocol initialization");
assert.equal(typeof sdk.Protocol.prototype.forToken, "function", "missing token operation binding");
assert.equal(
    typeof sdk.Protocol.prototype.aggregate,
    "function",
    "missing multi-token aggregation"
);
assert(!("resolveInstance" in sdk.Protocol.prototype), "retired token instance discovery remains");
const protocol = await import(resolve("packages/protocol/dist/index.js"));
for (const name of ["registrationAuthorizationRequest", "registrationPublicInputs"])
    assert(!(name in protocol), `retired registry circuit API: ${name}`);
assert(!("registration" in protocol.WitnessBuilder), "registry witness builder remains");
assert(
    !("prove" in protocol.RegistrationOperation.prototype),
    "registry operation requires a prover"
);
for (const name of ["registrationTypedData", "registrationDigest", "buildRegistrationCalldata"])
    assert.equal(typeof protocol[name], "function", `missing signature registry helper: ${name}`);
for (const name of ["buildApproveCalldata", "buildPermitTypedData", "permitTypes"])
    assert(!(name in protocol), `generic Ethereum helper must remain in ethers: ${name}`);

console.log(
    "Current public surface PASS: capability objects, no obsolete package or compatibility aliases"
);

for (const name of ["sync", "resync", "startSync", "stopSync", "applyUpdates"]) {
    assert(!(name in sdk.WalletSession.prototype), `wallet session must not scan: ${name}`);
}
assert.equal(
    typeof sdk.WalletSession.prototype.refresh,
    "function",
    "missing indexed refresh entry"
);

const ethersAdapter = await import(resolve("packages/sdk/dist/ethers.js"));
assert(!("EthersEventSource" in ethersAdapter), "public RPC scanner remains in ethers adapter");
for (const name of ["getTreeCount", "getMerkleRoot"]) {
    assert(
        !(name in ethersAdapter.EthersChainReader.prototype),
        `unused public tree query remains: ${name}`
    );
}
const wallet = await import(resolve("packages/sdk/dist/index.js"));
assert(!("WalletDiscovery" in wallet), "standalone discovery facade remains public");
const declaration = readFileSync("packages/sdk/dist/index.d.ts", "utf8");
for (const name of ["WalletUpdateBatch", "WalletUpdateResult", "ApplyUpdatesOptions"]) {
    assert(
        !new RegExp(String.raw`${name}`).test(declaration),
        `manual update contract remains public: ${name}`
    );
}

for (const name of ["prepareClue", "detectClue", "clueIsValid"]) {
    assert(!(name in core), `local detection implementation remains: ${name}`);
}
for (const name of ["detect", "classify"]) {
    assert(!(name in core.Detector.prototype), `local detector method remains: ${name}`);
}

for (const name of ["PreparedTransaction", "Operation"]) {
    for (const method of [
        "exportWalletAuthorization",
        "withWalletSignature",
        "exportFundingAuthorization",
        "withFundingSignature",
    ]) {
        assert.equal(
            typeof sdk[name].prototype[method],
            "function",
            `missing external signing API: ${name}.${method}`
        );
    }
}
for (const method of ["exportRegistrationAuthorization", "withSignature"]) {
    assert.equal(
        typeof sdk.RegistrationOperation.prototype[method],
        "function",
        `missing registry signing API: ${method}`
    );
}
