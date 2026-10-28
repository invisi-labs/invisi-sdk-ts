/** Measure complete receipts on an isolated local chain with current real verifiers. */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(resolve(root, "examples/package.json"));
const {
    JsonRpcProvider,
    Contract,
    ContractFactory,
    Interface,
    keccak256,
    ZeroAddress,
    ZeroHash,
} = require("ethers");
const { Invisi, Protocol, Wallet } = require("@invisi-labs/sdk");
const { poseidonHash } = require("@invisi-labs/core");
const { NativeProver } = require("@invisi-labs/prover/native");
const protocolRoot = resolve(
    process.env.INVISI_PROTOCOL_DIR ?? resolve(root, "../invisi-protocol")
);
const referenceCatalog = JSON.parse(
    readFileSync(resolve(root, "packages/sdk/src/data/gas-benchmarks.json"), "utf8")
);
const output = resolve(
    process.env.GAS_BENCHMARK_OUTPUT ?? resolve(root, "packages/sdk/src/data/gas-benchmarks.json")
);
const port = Number(process.env.GAS_BENCHMARK_PORT ?? 18945);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid benchmark port");
const url = `http://127.0.0.1:${port}`;
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: protocolRoot,
    encoding: "utf8",
}).trim();
if (
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: protocolRoot,
        encoding: "utf8",
    }).trim()
)
    throw new Error("Commit Protocol source changes before measuring");
execFileSync("forge", ["build"], { cwd: protocolRoot, stdio: "ignore" });
try {
    await fetch(url, { signal: AbortSignal.timeout(200) });
    throw new Error("Benchmark port is already in use");
} catch (error) {
    if (error.message === "Benchmark port is already in use") throw error;
}
const anvil = spawn(
    "anvil",
    [
        "--port",
        String(port),
        "--chain-id",
        "31337",
        "--hardfork",
        "osaka",
        "--gas-limit",
        "30000000",
        "--silent",
    ],
    { stdio: "ignore" }
);
let provider;
try {
    let started = false;
    for (let i = 0; i < 100; i++) {
        try {
            const reply = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
            });
            if ((await reply.json()).result === "0x7a69") {
                started = true;
                break;
            }
        } catch {
            /* Await only this process's local endpoint. */
        }
        await delay(100);
    }
    if (!started) throw new Error("Benchmark Anvil did not start");
    provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 25;
    const signer = await provider.getSigner(0);
    const account = await signer.getAddress();
    const deployed = new Map();
    function artifact(name) {
        return JSON.parse(
            readFileSync(
                resolve(
                    protocolRoot,
                    `contracts/out/${name.replace(/_Verifier$/, "_verifier")}.sol/${name}.json`
                ),
                "utf8"
            )
        );
    }
    async function linkedBytecode(name) {
        const a = artifact(name);
        let code = a.bytecode.object.replace(/^0x/, "");
        for (const references of Object.values(a.bytecode.linkReferences ?? {})) {
            for (const [library, positions] of Object.entries(references)) {
                if (!deployed.has(library)) deployed.set(library, await deploy(library));
                const address = (await deployed.get(library).getAddress()).slice(2);
                for (const p of positions)
                    code =
                        code.slice(0, p.start * 2) + address + code.slice((p.start + p.length) * 2);
            }
        }
        return `0x${code}`;
    }
    async function deploy(name, args = []) {
        const a = artifact(name);
        const factory = new ContractFactory(a.abi, await linkedBytecode(name), signer);
        const contract = await factory.deploy(...args);
        await contract.waitForDeployment();
        return contract;
    }
    const user = JSON.parse(
        readFileSync(resolve(protocolRoot, "circuits/transact-user-manifest.json"), "utf8")
    );
    const credit = JSON.parse(
        readFileSync(resolve(protocolRoot, "circuits/credit-manifest.json"), "utf8")
    );
    const direct = [];
    for (const entry of user.entries) {
        const raw = await deploy(entry.direct.verifier.contract);
        direct.push(
            await (
                await deploy("TransactUserVerifierAdapter", [
                    await raw.getAddress(),
                    entry.capacity,
                ])
            ).getAddress()
        );
    }
    const aggregates = [];
    for (const entry of user.aggregates) {
        const raw = await deploy(
            entry.verifier?.contract ??
                entry.outer?.verifier?.contract ??
                entry.direct?.verifier?.contract
        );
        aggregates.push(
            await (
                await deploy("TransactAggregateVerifierAdapter", [
                    await raw.getAddress(),
                    14,
                    entry.count,
                    user.entries[0].recursive.innerVkCommitment,
                ])
            ).getAddress()
        );
    }
    const creditRoutes = [];
    for (const entry of credit.entries) {
        const raw = await deploy(entry.direct.verifier.contract);
        creditRoutes.push(
            await (
                await deploy("CreditProofVerifierAdapter", [
                    await raw.getAddress(),
                    entry.publicInputCount,
                ])
            ).getAddress()
        );
    }
    const capacities = [14, 56, 112, 168];
    const single = await deploy("PrivateTransferVerifierRegistry", [
        capacities,
        [0, 0, 0, 0],
        direct,
    ]);
    const cross = await deploy("CrossTreeVerifierRegistry", [capacities, [0, 0, 0, 0], direct]);
    const router = await deploy("DualVerifierRouter", [
        await single.getAddress(),
        await cross.getAddress(),
        creditRoutes,
        aggregates,
    ]);
    const creationCode = await linkedBytecode("InvisiProtocol");
    const factory = await deploy("InvisiFactory", [
        account,
        account,
        await router.getAddress(),
        keccak256(creationCode),
    ]);
    const deploymentReceipt = await (
        await factory.getFunction("deploy")(creationCode, ZeroHash, account, account, ZeroAddress)
    ).wait();
    const instance = deploymentReceipt.logs
        .map((log) => {
            try {
                return factory.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((log) => log?.name === "InstanceDeployed").args.instance;
    const token = await deploy("MockERC20", ["Benchmark", "BENCH", 18]);
    const tokenAddress = await token.getAddress();
    const contract = new Contract(instance, artifact("InvisiProtocol").abi, signer);
    await (await token.mint(account, 10n ** 27n)).wait();
    const protocol = new Protocol({
        deployment: {
            chainId: 31337n,
            protocol: {
                address: instance,
                runtimeCodeHash: keccak256(await provider.getCode(instance)),
                fromBlock: BigInt(deploymentReceipt.blockNumber),
            },
        },
    });
    // Anvil's published development account only; no external wallet key is used.
    const wallet = await Wallet.fromPrivateKey(
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
    );
    const bob = await Wallet.fromPrivateKey(`0x${"02".repeat(32)}`);
    const prover = new NativeProver({
        ...(process.env.BB_BINARY_PATH ? { bbBin: process.env.BB_BINARY_PATH } : {}),
        threads: 4,
    });
    const leaves = [];
    const zeros = [0n];
    for (let i = 0; i < 16; i++) zeros.push(BigInt(await poseidonHash([zeros[i], zeros[i]])));
    async function membership(_context, input, block) {
        let level = [...leaves].map(BigInt);
        let index = input.leafIndex;
        const path = [];
        for (let depth = 0; depth < 16; depth++) {
            path.push(level[index ^ 1] ?? zeros[depth]);
            const next = [];
            for (let i = 0; i < level.length; i += 2)
                next.push(BigInt(await poseidonHash([level[i], level[i + 1] ?? zeros[depth]])));
            level = next;
            index >>= 1;
        }
        return {
            ...input,
            leaf: input.commitment,
            path,
            root: `0x${level[0].toString(16).padStart(64, "0")}`,
            block,
        };
    }
    const invisi = new Invisi({
        provider,
        signer,
        prover,
        protocolRpc: { getMembership: membership },
    });
    function events(receipt) {
        return receipt.logs
            .map((log) => {
                try {
                    return contract.interface.parseLog(log);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    }
    function append(receipt) {
        for (const event of events(receipt).filter(
            (event) => event.name === "CommitmentsInserted"
        )) {
            if (Number(event.args.startLeafIndex) !== leaves.length)
                throw new Error("Benchmark tree position gap");
            leaves.push(...event.args.commitments);
        }
    }
    async function complete(prepared) {
        const review = prepared.preview();
        let ready = review.permissions.walletAuthorization ? await prepared.authorize() : prepared;
        ready = review.permissions.proof ? await ready.prove() : await ready.ready();
        if (review.permissions.fundingAuthorization) ready = await ready.authorizeFunding();
        const call = await ready.exportTransaction();
        const receipt = await (await signer.sendTransaction(call)).wait();
        if (receipt.status !== 1) throw new Error("Benchmark transaction reverted");
        return { ready, call, receipt };
    }
    async function shield(amount, count = 1, deadline) {
        await (await token.approve(instance, amount)).wait();
        return invisi.prepareShield({
            wallet,
            protocol,
            tokenAddress,
            outputs: Array.from({ length: count }, () => ({
                to: wallet.getAddress(),
                amount: amount / BigInt(count),
            })),
            funding: { payer: account, amount, authorization: "caller" },
            ...(deadline ? { deadline } : {}),
        });
    }
    const seed = await complete(await shield(1000n));
    append(seed.receipt);
    const seedEvents = events(seed.receipt);
    const noteCommitment = seedEvents.find((event) => event.name === "CommitmentsInserted").args
        .commitments[0];
    const note = await wallet
        .getViewer()
        .decryptNote(
            seedEvents.find((event) => event.name === "Shield").args.deliveries[0].ciphertext,
            {
                chainId: 31337n,
                protocolAddress: BigInt(instance),
                tokenAddress: BigInt(tokenAddress),
                outputCommitment: BigInt(noteCommitment),
            }
        );
    const inputs = [{ note, commitment: noteCommitment, treeId: 1n, leafIndex: 0 }];
    await (await token.approve(instance, 100n)).wait();
    const now = BigInt((await provider.getBlock("latest")).timestamp);
    const creditSeed = await complete(
        await invisi.prepareCreateCredit({
            wallet,
            protocol,
            tokenAddress,
            inputs: [],
            spender: bob.getAddress(),
            amount: 100n,
            expiry: now + 86400n,
            funding: { payer: account, amount: 100n, authorization: "caller" },
        })
    );
    append(creditSeed.receipt);
    const created = events(creditSeed.receipt).find((event) => event.name === "CreditCreated");
    const state = await wallet.getViewer().decryptCredit(created.args.deliveries[0].ciphertext, {
        chainId: 31337n,
        protocolAddress: BigInt(instance),
        tokenAddress: BigInt(tokenAddress),
        outputCommitment: BigInt(created.args.creditCommitment),
        role: "owner",
    });
    const creditInput = {
        state,
        commitment: created.args.creditCommitment,
        treeId: 1n,
        leafIndex: Number(created.args.leafIndices[0]),
        role: "owner",
    };
    let snapshot = await provider.send("evm_snapshot", []);
    const profile = {
        formatVersion: 1,
        id: `protocol-${revision.slice(0, 7)}-osaka-real`,
        deployment: null,
        source: {
            protocolCommit: revision,
            measuredAt: new Date().toISOString(),
            chain: "Anvil 31337",
            hardfork: "osaka",
            token: "MockERC20",
            verifier: "real",
            assumptions: [
                "normal CREATE/Factory deployment; no code or storage injection",
                "Solidity 0.8.27 optimizer 200; real BB 6.0.0 verifiers",
                "one source tree; two existing leaves; no rollover or screener",
                "funding/approval setup excluded; complete transaction receipt gas included",
                "exact allowance for caller funding; configured benchmark payout balances",
                "observed local samples, not a confidence interval or gas limit",
            ],
        },
        measurements: [],
    };
    const cases = [
        ...[1, 2, 10].map((count) => ({
            id: `shield-${count}`,
            prepare: (deadline) => shield(BigInt(count) * 100n, count, deadline),
        })),
        ...[1, 13, 55, 111].map((count) => ({
            id: `transfer-1x${count + 1}`,
            prepare: (deadline) =>
                invisi.prepareTransfer({
                    wallet,
                    protocol,
                    tokenAddress,
                    inputs,
                    outputs: Array.from({ length: count }, () => ({
                        to: bob.getAddress(),
                        amount: 1n,
                    })),
                    deadline,
                }),
        })),
        {
            id: "withdraw-1x1",
            prepare: (deadline) =>
                invisi.prepareWithdraw({
                    wallet,
                    protocol,
                    tokenAddress,
                    inputs,
                    to: bob.ownerAddress,
                    amount: 30n,
                    deadline,
                }),
        },
        {
            id: "sweep-1x0",
            prepare: (deadline) =>
                invisi.prepareSweep({
                    wallet: Wallet.fromAddress(wallet.getAddress()),
                    protocol,
                    tokenAddress,
                    inputs,
                    deadline,
                }),
        },
        {
            id: "create-credit-1x1",
            prepare: (deadline) =>
                invisi.prepareCreateCredit({
                    wallet,
                    protocol,
                    tokenAddress,
                    inputs,
                    spender: bob.getAddress(),
                    amount: 100n,
                    expiry: now + 86400n,
                    deadline,
                }),
        },
        {
            id: "draw-credit-1-partial",
            prepare: (deadline) =>
                invisi.prepareDrawCredit({
                    wallet: bob,
                    protocol,
                    tokenAddress,
                    creditInputs: [{ ...creditInput, role: "spender" }],
                    credits: [{ credit: creditInput.commitment, amount: 30n }],
                    deadline,
                }),
        },
        {
            id: "top-up-credit-1x1",
            prepare: (deadline) =>
                invisi.prepareTopUpCredit({
                    wallet,
                    protocol,
                    tokenAddress,
                    inputs,
                    creditInputs: [creditInput],
                    credit: creditInput.commitment,
                    additionalAmount: 80n,
                    expiry: now + 172800n,
                    deadline,
                }),
        },
        {
            id: "cancel-credit-1",
            prepare: (deadline) =>
                invisi.prepareCancelCredit({
                    wallet,
                    protocol,
                    tokenAddress,
                    creditInputs: [creditInput],
                    credit: creditInput.commitment,
                    deadline,
                }),
        },
    ];
    const selected = process.env.GAS_BENCHMARK_CASES?.split(",");
    if (selected?.some((id) => !cases.some((scenario) => scenario.id === id)))
        throw new Error("Unknown benchmark case");
    for (const scenario of cases.filter(
        (scenario) => !selected || selected.includes(scenario.id)
    )) {
        const measurement = { id: scenario.id, shape: null, circuit: null, samples: [] };
        for (let round = 0; round < 3; round++) {
            if (!(await provider.send("evm_revert", [snapshot])))
                throw new Error("Benchmark snapshot restore failed");
            snapshot = await provider.send("evm_snapshot", []);
            const prepared = await scenario.prepare(now + 3600n + BigInt(round));
            const estimate = prepared.estimateGas();
            // The reproduction matrix is version-pinned; never relabel old circuit identities.
            const reference = referenceCatalog.find(
                (entry) => entry.source.protocolCommit === revision
            );
            const template = reference?.measurements.find((entry) => entry.id === scenario.id);
            if (!template)
                throw new Error(
                    "Update and review the measurement matrix for this protocol revision"
                );
            const preview = prepared.preview();
            if (
                preview.kind !== template.shape.kind ||
                preview.capacity !== (template.shape.capacity || undefined) ||
                preview.outputs.length !== template.shape.noteOutputs
            ) {
                throw new Error("Prepared operation differs from the benchmark matrix");
            }
            profile.deployment = {
                chainId: "31337",
                protocolAddress: instance,
                runtimeCodeHash: keccak256(await provider.getCode(instance)),
                tokenAddress,
            };
            measurement.shape = structuredClone(template.shape);
            measurement.circuit = structuredClone(template.circuit);
            const { receipt, call } = await complete(prepared);
            measurement.samples.push({
                gasUsed: receipt.gasUsed.toString(),
                transactionHash: receipt.hash,
                blockNumber: String(receipt.blockNumber),
                blockHash: receipt.blockHash,
                calldataBytes: (call.data.length - 2) / 2,
            });
            console.log(
                `${scenario.id} ${round + 1}/3: ${receipt.gasUsed} gas (reference ${estimate.gasUnits})`
            );
        }
        profile.measurements.push(measurement);
        if (
            execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: protocolRoot,
                encoding: "utf8",
            }).trim() !== revision
        )
            throw new Error("Protocol revision changed during measurement");
        writeFileSync(output, JSON.stringify([profile], null, 2) + "\n");
    }
    console.log(
        `Saved ${profile.measurements.length} current real-verifier benchmark shapes to ${output}`
    );
} finally {
    provider?.destroy();
    anvil.kill("SIGTERM");
}
