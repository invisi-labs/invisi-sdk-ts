/** Reproduce SDK local presets on a fresh Anvil node; never run against another chain. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(resolve(root, "examples/package.json"));
const { JsonRpcProvider, keccak256, getAddress } = require("ethers");
const rpc = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
const url = new URL(rpc);
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    throw new Error("Local deployment requires a loopback RPC");
const provider = new JsonRpcProvider(rpc);
if ((await provider.getNetwork()).chainId !== 31337n)
    throw new Error("Local deployment requires chainId 31337");
const mode = process.argv[2] ?? "--deploy";
if (!["--deploy", "--record", "--check"].includes(mode))
    throw new Error("Use --deploy, --check or maintainer --record");
const protocolRoot = resolve(
    process.env.INVISI_PROTOCOL_DIR ?? resolve(root, "../invisi-protocol")
);
const account = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
const output = resolve(
    process.env.INVISI_DEPLOYMENT_CATALOG ?? resolve(protocolRoot, "deployment/deployment.json")
);
function selectedProfile() {
    const catalog = JSON.parse(readFileSync(output, "utf8"));
    const profile = catalog.chains?.["31337"];
    if (catalog.version !== 1 || !profile)
        throw new Error("Protocol deployment catalog has no chain 31337 deployment");
    return {
        chainId: "31337",

        protocol: { ...profile.protocol, fromBlock: String(profile.protocol.fromBlock) },
        ...(profile.registry
            ? { registry: { ...profile.registry, fromBlock: String(profile.registry.fromBlock) } }
            : {}),
    };
}

async function runtimeHash(address) {
    const code = await provider.getCode(address);
    if (!code || code === "0x")
        throw new Error(`No contract code at ${address}; deploy the matching local profile first`);
    return keccak256(code);
}

if (mode === "--check") {
    const profile = selectedProfile();
    if ((await runtimeHash(profile.protocol.address)) !== profile.protocol.runtimeCodeHash)
        throw new Error("Protocol runtime mismatch");
    if ((await runtimeHash(profile.registry.address)) !== profile.registry.runtimeCodeHash)
        throw new Error("Registry runtime mismatch");
    const { Contract } = require("ethers");
    const instance = new Contract(
        profile.protocol.address,
        ["function addressRegistry() view returns (address)"],
        provider
    );
    if (getAddress(await instance.addressRegistry()) !== getAddress(profile.registry.address))
        throw new Error("Protocol registry binding mismatch");
    console.log(
        "Local Protocol and registry deployment profiles match the running chain (mock verifiers)."
    );
    provider.destroy();
    process.exit(0);
}

if (mode === "--deploy" || mode === "--record") {
    if (
        (await provider.getTransactionCount(account)) !== 0 ||
        (await provider.getBlockNumber()) !== 0
    )
        throw new Error("Start a fresh Anvil node with the default test mnemonic");
    execFileSync(
        "forge",
        [
            "script",
            "contracts/script/DeployLocal.s.sol:DeployLocal",
            "--rpc-url",
            rpc,
            "--broadcast",
            "--slow",
            "--sender",
            account,
        ],
        {
            cwd: protocolRoot,
            stdio: "inherit",
            env: {
                ...process.env,
                DEPLOYER_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
            },
        }
    );
}

// This broadcast belongs to the controlled local deployment, not an unknown RPC trust source.
const addresses = JSON.parse(
    readFileSync(resolve(protocolRoot, "contracts/out/local-deployment.json"), "utf8")
);
const broadcast = JSON.parse(
    readFileSync(resolve(protocolRoot, "broadcast/DeployLocal.s.sol/31337/run-latest.json"), "utf8")
);
if (addresses.chainId !== 31337 || getAddress(addresses.factoryOwner) !== account)
    throw new Error("Invalid local deployment record");
const registryAddress = getAddress(addresses.registry);
const registryTransaction = broadcast.transactions.find(
    (tx) =>
        tx.contractName === "InvisiAddressRegistry" &&
        tx.contractAddress?.toLowerCase() === registryAddress.toLowerCase()
);
if (!registryTransaction) throw new Error("Missing registry deployment transaction");
const registryReceipt = await provider.getTransactionReceipt(registryTransaction.hash);
if (!registryReceipt || registryReceipt.status !== 1)
    throw new Error("Registry deployment reverted");
const registry = {
    address: registryAddress,
    runtimeCodeHash: await runtimeHash(registryAddress),
    fromBlock: registryReceipt.blockNumber.toString(),
};
const protocolAddress = getAddress(addresses.protocolAddress);
const factoryAddress = getAddress(addresses.factory);
const deploymentTx = broadcast.transactions.find(
    (tx) =>
        tx.contractAddress?.toLowerCase() === factoryAddress.toLowerCase() &&
        tx.transactionType === "CALL" &&
        tx.function?.startsWith("deploy(")
);
if (!deploymentTx) throw new Error("Missing Protocol deployment transaction");
const deploymentReceipt = await provider.getTransactionReceipt(deploymentTx.hash);
if (!deploymentReceipt || deploymentReceipt.status !== 1)
    throw new Error("Protocol deployment reverted");
const fromBlock = deploymentReceipt.blockNumber;
if (
    (await provider.getCode(protocolAddress, fromBlock)) === "0x" ||
    (fromBlock > 0 && (await provider.getCode(protocolAddress, fromBlock - 1)) !== "0x")
)
    throw new Error("Protocol deployment block does not match its creation");
const deployment = {
    chainId: "31337",
    protocol: {
        address: protocolAddress,
        runtimeCodeHash: await runtimeHash(protocolAddress),
        fromBlock: fromBlock.toString(),
    },

    registry,
};
if (mode === "--record") {
    const { writeDeployment } = await import(
        pathToFileURL(resolve(protocolRoot, "scripts/deployment-catalog.mjs")).href
    );
    writeDeployment(output, "31337", {
        name: "Anvil",
        protocol: { ...deployment.protocol, fromBlock: Number(deployment.protocol.fromBlock) },
        registry: { ...registry, fromBlock: Number(registry.fromBlock) },
    });
    console.log(
        "Recorded controlled local protocol deployment. Initialize or update the Protocol RPC service configuration before using it."
    );
} else {
    const expected = selectedProfile();
    if (!isDeepStrictEqual(deployment, expected))
        throw new Error(
            "Local deployment differs from the Protocol deployment catalog; maintainers must review and regenerate with --record on a fresh Anvil node"
        );
    console.log("Local deployment matches the Protocol deployment catalog (mock verifiers).");
}
console.log("Seeded USDC:", addresses.usdc);
console.log("Seeded USDT:", addresses.usdt);

provider.destroy();
