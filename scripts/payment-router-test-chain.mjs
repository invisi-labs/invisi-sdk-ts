/** Owned local Anvil fixture for cross-SDK Router execution; all external boundaries are doubles. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
    buildTransactCalldata,
    EMPTY_FUNDING,
    ZERO_ADDRESS,
} from "../packages/protocol/dist/index.js";
const require = createRequire(new URL("../packages/payment-router/package.json", import.meta.url));
const { ContractFactory, Interface, JsonRpcProvider, keccak256 } = require("ethers");
const [repository, output] = process.argv.slice(2);
assert(repository && output, "Usage: payment-router-test-chain.mjs PERIPHERY_REPO OUTPUT_JSON");
const socket = createServer();
await new Promise((done) => socket.listen(0, "127.0.0.1", done));
const port = socket.address().port;
await new Promise((done, fail) => socket.close((error) => (error ? fail(error) : done())));
const child = spawn(
    "anvil",
    ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--silent"],
    { stdio: "ignore" }
);
const rpcUrl = `http://127.0.0.1:${port}`;
const provider = new JsonRpcProvider(rpcUrl, 31337, {
    staticNetwork: true,
    cacheTimeout: -1,
    pollingInterval: 20,
});
function cleanup() {
    provider.destroy();
    child.kill();
}
process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
});
process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
});
process.on("exit", () => child.kill());
try {
    for (let i = 0; ; i++) {
        try {
            await provider.getBlockNumber();
            break;
        } catch (error) {
            if (i === 50) throw error;
            await delay(100);
        }
    }
    const signer = await provider.getSigner(0);
    const player = await signer.getAddress();
    async function deploy(name, args = []) {
        const file = ["TestToken", "TestWETH", "CoreDouble", "SwapDouble"].includes(name)
            ? "PaymentDoubles"
            : ["SettlerDouble", "AllowanceHolderDouble", "SettlerRegistryDouble"].includes(name)
              ? "ZeroExDoubles"
              : name;
        const artifact = JSON.parse(
            readFileSync(resolve(repository, "out", `${file}.sol`, `${name}.json`), "utf8")
        );
        const contract = await new ContractFactory(
            artifact.abi,
            artifact.bytecode.object,
            signer
        ).deploy(...args);
        await contract.waitForDeployment();
        return contract;
    }
    const token = await deploy("TestToken"),
        weth = await deploy("TestWETH"),
        core = await deploy("CoreDouble");
    const dex = await deploy("SwapDouble", [await weth.getAddress(), await token.getAddress()]);
    const settler = await deploy("SettlerDouble"),
        holder = await deploy("AllowanceHolderDouble");
    const registry = await deploy("SettlerRegistryDouble", [await settler.getAddress()]);
    const router = await deploy("ZeroExPaymentRouter", [
        await core.getAddress(),
        await dex.getAddress(),
        await weth.getAddress(),
        await holder.getAddress(),
        await registry.getAddress(),
    ]);
    for (const target of [dex, settler])
        await (await token.getFunction("mint")(await target.getAddress(), 1000000n)).wait();
    const deployment = {
        chainId: 31337n,
        routerAddress: await router.getAddress(),
        coreAddress: await core.getAddress(),
        wethAddress: await weth.getAddress(),
        uniswapRouterAddress: await dex.getAddress(),
        runtimeCodeHash: keccak256(await provider.getCode(await router.getAddress())),
        zeroEx: {
            allowanceHolderAddress: await holder.getAddress(),
            settlerRegistryAddress: await registry.getAddress(),
        },
    };
    const latest = await provider.getBlock("latest"),
        deadline = BigInt(latest.timestamp) + 86400n;
    const tokenOut = await token.getAddress(),
        maxInput = 1000000000000000000n,
        estimatedInput = 600000000000000000n;
    const data = buildTransactCalldata({
        context: {
            chainId: 31337n,
            protocolAddress: deployment.coreAddress,
            tokenAddress: tokenOut,
            now: BigInt(latest.timestamp),
        },
        proof: "0x1234",
        params: {
            token: tokenOut,
            sources: [],
            nullifiers: [],
            noteCommitments: ["0x" + "17".padStart(64, "0"), "0x" + "18".padStart(64, "0")],
            withdrawalAddress: ZERO_ADDRESS,
            withdrawalAmount: 0n,
            deadline,
            feeRecipient: ZERO_ADDRESS,
            feeAmount: 0n,
        },
        deliveries: [
            { ciphertext: "0x", clue: "0x" },
            { ciphertext: "0x", clue: "0x" },
        ],
        funding: { ...EMPTY_FUNDING, payer: deployment.routerAddress, amount: 10n },
        caller: deployment.routerAddress,
    }).data;
    const abi = new Interface([
        "function execute((address recipient,address buyToken,uint256 minAmountOut) slippage,bytes[] actions,bytes32 zid) payable returns(bool)",
        "function exec(address operator,address token,uint256 amount,address target,bytes data) payable returns(bytes)",
        "function NATIVE_CHECK(uint256 deadline,uint256 msgValue)",
    ]);
    const native = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
    const payload = abi.encodeFunctionData("execute", [
        [deployment.routerAddress, tokenOut, 10n],
        [abi.encodeFunctionData("NATIVE_CHECK", [deadline, maxInput])],
        "0x" + "00".repeat(32),
    ]);
    const wrapped = abi.encodeFunctionData("exec", [
        await settler.getAddress(),
        native,
        0n,
        await settler.getAddress(),
        payload,
    ]);
    const common = {
        chainId: 31337n,
        routerAddress: deployment.routerAddress,
        tokenOut,
        amountOut: 10n,
        estimatedInput,
        maxInput,
        deadline,
    };
    const fixture = {
        format: "invisi.payment-router.local-anvil.v1",
        rpcUrl,
        player,
        deployment,
        tokenOut,
        settlerAddress: await settler.getAddress(),
        corePayment: { to: deployment.coreAddress, data, value: 0n },
        refundRecipient: player,
        quotes: [
            {
                ...common,
                channel: "uniswap-v3",
                reversePath:
                    tokenOut.toLowerCase() +
                    "000bb8" +
                    deployment.wethAddress.slice(2).toLowerCase(),
            },
            {
                ...common,
                channel: "zeroex",
                target: await settler.getAddress(),
                data: payload,
                settlerAddress: await settler.getAddress(),
            },
            {
                ...common,
                channel: "zeroex",
                target: await holder.getAddress(),
                data: wrapped,
                settlerAddress: await settler.getAddress(),
            },
        ],
        expected: {
            ethSpent: estimatedInput,
            ethRefunded: maxInput - estimatedInput,
            fundingAmount: 10n,
        },
    };
    writeFileSync(
        output,
        JSON.stringify(fixture, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n",
        { mode: 0o600 }
    );
    console.log(`Owned local Router fixture ready: ${output}`);
    // Child keeps this process alive; termination always closes the owned chain.
    child.on("exit", (code) => process.exit(code ?? 1));
} catch (error) {
    cleanup();
    throw error;
}
