/** Complete current Credit receipts on isolated Prague Anvil; never changes a deployment catalog. */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import {
    sha256,
    sourceIdentity,
    fingerprintFiles,
    BenchmarkMerkleTree,
} from "./benchmark-gas-source.mjs";
const root = resolve(import.meta.dirname, ".."),
    require = createRequire(join(root, "packages/sdk/package.json"));
const {
    JsonRpcProvider,
    Contract,
    ContractFactory,
    Interface,
    keccak256,
    ZeroAddress,
    ZeroHash,
    MaxUint256,
    Wallet: EvmWallet,
} = require("ethers");
const { Invisi, Protocol, Wallet, PublicWallet } = require("@invisi-labs/sdk");
const { poseidonHash } = require("@invisi-labs/core");
const { NativeProver } = require("@invisi-labs/prover/native");
const protocolRoot = resolve(process.env.INVISI_PROTOCOL_DIR ?? join(root, "../invisi-protocol"));
const output = resolve(
    process.env.GAS_BENCHMARK_OUTPUT ?? join(root, "packages/sdk/src/data/gas-benchmarks.json")
);
const evidenceDir = resolve(
    process.env.GAS_BENCHMARK_EVIDENCE ?? `/tmp/invisi-credit-gas-evidence-${Date.now()}`
);
mkdirSync(evidenceDir, { recursive: true });
const stringify = (v) =>
    JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n";
const git = (...args) =>
    execFileSync("git", args, { cwd: protocolRoot, maxBuffer: 64 * 1024 * 1024 });
const revision = git("rev-parse", "HEAD").toString().trim();
const initialSources = sourceIdentity(protocolRoot),
    sdkSources = sourceIdentity(root),
    dirtyDiffSha256 = sha256(git("diff", "--binary", "HEAD"));
for (const script of ["credit-proof-release.mjs", "transact-user-release.mjs"])
    execFileSync(process.execPath, [join(protocolRoot, "scripts", script)], {
        cwd: protocolRoot,
        stdio: "inherit",
    });
execFileSync("forge", ["build"], { cwd: protocolRoot, stdio: "ignore" });
const foundry = readFileSync(join(protocolRoot, "foundry.toml"), "utf8");
if (!/solc\s*=\s*"0\.8\.38"/.test(foundry) || !/evm_version\s*=\s*"prague"/.test(foundry))
    throw Error("Benchmark requires pinned Solidity0.8.38 Prague config");
const bbBin = process.env.BB_BINARY_PATH ?? join(protocolRoot, ".tools/bb/bb");
if (execFileSync(bbBin, ["--version"]).toString().trim() !== "6.0.0")
    throw Error("BB6.0.0 required");
const user = JSON.parse(readFileSync(join(protocolRoot, "circuits/transact-user-manifest.json"))),
    credit = JSON.parse(readFileSync(join(protocolRoot, "circuits/credit-manifest.json")));
const port = Number(process.env.GAS_BENCHMARK_PORT ?? 18945),
    blockGasLimit = BigInt(process.env.GAS_BENCHMARK_BLOCK_GAS_LIMIT ?? 500000000);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || blockGasLimit < 30000000n)
    throw Error("Invalid local benchmark configuration");
const url = `http://127.0.0.1:${port}`;
try {
    await fetch(url, { signal: AbortSignal.timeout(200) });
    throw Error("Benchmark port already in use");
} catch (e) {
    if (e.message === "Benchmark port already in use") throw e;
}
const anvil = spawn(
    "anvil",
    [
        "--port",
        String(port),
        "--chain-id",
        "31337",
        "--hardfork",
        "prague",
        "--gas-limit",
        String(blockGasLimit),
        "--timestamp",
        "2000000000",
        "--silent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] }
);
let anvilErrors = "";
anvil.stderr.on("data", (b) => (anvilErrors += b.toString()));
let provider;
const usedArtifacts = new Map(),
    runtimeContracts = {},
    setupReceipts = [],
    samplesEvidence = [];
function guard() {
    const protocolNow = sourceIdentity(protocolRoot),
        sdkNow = sourceIdentity(root);
    const changed = (before, after) =>
        [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
            .filter((p) => before.files[p] !== after.files[p])
            .map((path) => ({
                path,
                before: before.files[path] ?? null,
                after: after.files[path] ?? null,
            }));
    const drift = {
        headBefore: revision,
        headAfter: git("rev-parse", "HEAD").toString().trim(),
        protocol: changed(initialSources, protocolNow),
        sdk: changed(sdkSources, sdkNow),
    };
    if (drift.headAfter !== revision || drift.protocol.length || drift.sdk.length) {
        writeFileSync(join(evidenceDir, "source-drift.json"), stringify(drift));
        throw Error(
            "Executable source changed during benchmark; refusing publication: " +
                JSON.stringify(drift)
        );
    }
    for (const [path, hash] of usedArtifacts)
        if (sha256(readFileSync(join(protocolRoot, path))) !== hash)
            throw Error("Compiled artifact changed during benchmark: " + path);
}
try {
    writeFileSync(
        join(evidenceDir, "start.json"),
        stringify({
            revision,
            initialSources,
            sdkSources,
            dirtyDiffSha256,
            blockGasLimit: String(blockGasLimit),
        })
    );
    guard();
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
        } catch {}
        await delay(100);
    }
    if (!started) throw Error("Benchmark Anvil failed: " + anvilErrors);
    provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 20;
    const signer = await provider.getSigner(0),
        account = await signer.getAddress(),
        deployed = new Map();
    const deploymentOverrides = { gasLimit: blockGasLimit - 1n };
    function artifact(name) {
        const path = `contracts/out/${name.replace(/_Verifier$/, "_verifier")}.sol/${name}.json`,
            bytes = readFileSync(join(protocolRoot, path));
        const hash = sha256(bytes);
        if (usedArtifacts.has(path) && usedArtifacts.get(path) !== hash)
            throw Error("Artifact changed");
        usedArtifacts.set(path, hash);
        const parsed = JSON.parse(bytes);
        if (
            !parsed.metadata?.compiler?.version?.startsWith("0.8.38+") ||
            parsed.metadata.settings.evmVersion !== "prague" ||
            parsed.metadata.settings.optimizer.runs !== 200
        )
            throw Error("Compiled artifact toolchain differs from pinned benchmark");
        return parsed;
    }
    async function linkedBytecode(name) {
        const a = artifact(name);
        let code = a.bytecode.object.replace(/^0x/, "");
        for (const references of Object.values(a.bytecode.linkReferences ?? {}))
            for (const [library, positions] of Object.entries(references)) {
                if (!deployed.has(library)) deployed.set(library, await deploy(library));
                const address = (await deployed.get(library).getAddress()).slice(2);
                for (const p of positions)
                    code =
                        code.slice(0, p.start * 2) + address + code.slice((p.start + p.length) * 2);
            }
        return "0x" + code;
    }
    async function deploy(name, args = [], label = name) {
        const a = artifact(name),
            factory = new ContractFactory(a.abi, await linkedBytecode(name), signer),
            contract = await factory.deploy(...args, deploymentOverrides);
        const receipt = await contract.deploymentTransaction().wait();
        if (receipt.status !== 1) throw Error("Deployment reverted " + name);
        await contract.waitForDeployment();
        const address = await contract.getAddress();
        runtimeContracts[label] = {
            address,
            runtimeCodeHash: keccak256(await provider.getCode(address)),
        };
        setupReceipts.push({ kind: "deploy:" + label, ...receipt.toJSON() });
        return contract;
    }
    const direct = [];
    for (const entry of user.entries) {
        const raw = await deploy(entry.direct.verifier.contract);
        direct.push(
            await (
                await deploy(
                    "TransactUserVerifierAdapter",
                    [await raw.getAddress(), entry.capacity],
                    entry.name + "-adapter"
                )
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
                await deploy(
                    "TransactAggregateVerifierAdapter",
                    [
                        await raw.getAddress(),
                        14,
                        entry.count,
                        user.entries[0].recursive.innerVkCommitment,
                    ],
                    entry.name + "-adapter"
                )
            ).getAddress()
        );
    }
    const creditRoutes = [];
    for (const entry of credit.entries) {
        const raw = await deploy(entry.direct.verifier.contract);
        creditRoutes.push(
            await (
                await deploy(
                    "CreditProofVerifierAdapter",
                    [await raw.getAddress(), entry.publicInputCount],
                    entry.name + "-adapter"
                )
            ).getAddress()
        );
    }
    const capacities = [14, 56, 112, 168],
        single = await deploy("PrivateTransferVerifierRegistry", [
            capacities,
            [0, 0, 0, 0],
            direct,
        ]),
        cross = await deploy("CrossTreeVerifierRegistry", [capacities, [0, 0, 0, 0], direct]);
    const router = await deploy("DualVerifierRouter", [
        await single.getAddress(),
        await cross.getAddress(),
        creditRoutes,
        aggregates,
    ]);
    const creationCode = await linkedBytecode("InvisiProtocol"),
        factory = await deploy("InvisiFactory", [
            account,
            account,
            await router.getAddress(),
            keccak256(creationCode),
        ]),
        registry = await deploy("InvisiAddressRegistry");
    const deploymentReceipt = await (
        await factory.getFunction("deploy")(
            creationCode,
            ZeroHash,
            account,
            account,
            ZeroAddress,
            await registry.getAddress(),
            deploymentOverrides
        )
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
    runtimeContracts.InvisiProtocol = {
        address: instance,
        runtimeCodeHash: keccak256(await provider.getCode(instance)),
    };
    setupReceipts.push({ kind: "factory-instance", ...deploymentReceipt.toJSON() });
    const token = await deploy("MockERC20", ["Benchmark", "BENCH", 18]),
        tokenAddress = await token.getAddress(),
        contract = new Contract(instance, artifact("InvisiProtocol").abi, signer);
    await (await token.mint(account, 10n ** 27n)).wait();
    await (await token.approve(instance, MaxUint256)).wait();
    const protocol = new Protocol({
        deployment: {
            chainId: 31337n,
            protocol: {
                address: instance,
                runtimeCodeHash: runtimeContracts.InvisiProtocol.runtimeCodeHash,
                fromBlock: BigInt(deploymentReceipt.blockNumber),
            },
            registry: {
                address: await registry.getAddress(),
                runtimeCodeHash: runtimeContracts.InvisiAddressRegistry.runtimeCodeHash,
                fromBlock: BigInt(deploymentReceipt.blockNumber),
            },
        },
    });
    const wallet = await Wallet.fromPrivateKey(
            "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        ),
        bob = await Wallet.fromPrivateKey("0x" + "02".repeat(32)),
        prover = new NativeProver({ bbBin, threads: 4 });
    const tree = await new BenchmarkMerkleTree(poseidonHash).initialize();
    const membership = async (_context, input, block) => {
        const m = tree.membership(input.leafIndex);
        if (BigInt(input.commitment) !== m.leaf) throw Error("Benchmark leaf mismatch");
        return {
            ...input,
            leaf: input.commitment,
            path: m.path,
            root: "0x" + m.root.toString(16).padStart(64, "0"),
            block,
        };
    };
    const invisi = new Invisi({
        provider,
        prover,
        protocolRpc: { getMembership: membership },
    });
    const events = (receipt) =>
        receipt.logs
            .map((log) => {
                try {
                    return contract.interface.parseLog(log);
                } catch {
                    return null;
                }
            })
            .filter(Boolean);
    async function append(receipt) {
        for (const event of events(receipt).filter((e) => e.name === "CommitmentsInserted")) {
            if (Number(event.args.startLeafIndex) !== tree.size) throw Error("Benchmark tree gap");
            for (const leaf of event.args.commitments) await tree.insert(leaf);
        }
    }
    async function complete(prepared, record = false) {
        const review = prepared.preview(),
            started = performance.now();
        let ready = prepared;
        if (review.permissions.walletAuthorization) {
            const request = await prepared.exportWalletAuthorization();
            const author =
                review.kind === "draw-credit" ? new EvmWallet("0x" + "02".repeat(32)) : signer;
            ready = await prepared.withWalletSignature(
                await author.signTypedData(request.domain, request.types, request.message)
            );
        }
        const authorized = performance.now();
        ready = review.permissions.proof ? await ready.prove() : await ready.ready();
        const proved = performance.now();
        if (review.permissions.fundingAuthorization) {
            const request = await ready.exportFundingAuthorization();
            ready = await ready.withFundingSignature(
                await signer.signTypedData(request.domain, request.types, request.message)
            );
        }
        const call = await ready.exportTransaction(),
            proof = review.permissions.proof ? ready.exportProof() : null;
        const receipt = await (
            await signer.sendTransaction({ ...call, gasLimit: blockGasLimit - 1n })
        ).wait();
        if (receipt.status !== 1) throw Error("Benchmark transaction reverted");
        if (!record) setupReceipts.push({ kind: review.kind, ...receipt.toJSON() });
        return {
            ready,
            call,
            receipt,
            proof,
            timings: {
                authorizationMs: authorized - started,
                witnessNativeProofAndVerificationMs: proved - authorized,
            },
        };
    }
    const now = BigInt((await provider.getBlock("latest")).timestamp),
        expiry = now + 365n * 86400n;
    const shield = await complete(
        await invisi.prepareShield({
            wallet: PublicWallet.fromAddress(wallet.getAddress()),
            protocol,
            tokenAddress,
            outputs: [{ to: wallet.getAddress(), amount: 1000n }],
            funding: { payer: account, amount: 1000n, authorization: "caller" },
        })
    );
    await append(shield.receipt);
    const shieldEvent = events(shield.receipt).find((e) => e.name === "Shield"),
        noteCommitment = events(shield.receipt).find((e) => e.name === "CommitmentsInserted").args
            .commitments[0];
    const note = await wallet.getViewer().decryptNote(shieldEvent.args.deliveries[0].ciphertext, {
            chainId: 31337n,
            protocolAddress: BigInt(instance),
            tokenAddress: BigInt(tokenAddress),
            outputCommitment: BigInt(noteCommitment),
        }),
        inputs = [{ note, commitment: noteCommitment, treeId: 1n, leafIndex: 0 }];
    const fresh = [];
    async function createSeed() {
        return invisi.prepareCreateCredit({
            wallet: PublicWallet.fromAddress(wallet.getAddress()),
            protocol,
            tokenAddress,
            inputs: [],
            spender: bob.getAddress(),
            amount: 100n,
            expiry,
            singleLimit: 100n,
            dailyLimit: 200n,
            monthlyLimit: 300n,
            funding: { payer: account, amount: 100n, authorization: "caller" },
        });
    }
    async function readCredit(receipt) {
        const created = events(receipt).find((e) => e.name === "CreditCreated"),
            state = await wallet.getViewer().decryptCredit(created.args.deliveries[0].ciphertext, {
                chainId: 31337n,
                protocolAddress: BigInt(instance),
                tokenAddress: BigInt(tokenAddress),
                outputCommitment: BigInt(created.args.creditCommitment),
                role: "owner",
            });
        return {
            state,
            commitment: created.args.creditCommitment,
            treeId: 1n,
            leafIndex: Number(created.args.leafIndices[0]),
            role: "owner",
        };
    }
    const selectedSeedCases = process.env.GAS_BENCHMARK_CASES?.split(",");
    const seedCount = selectedSeedCases
        ? Math.max(
              1,
              ...selectedSeedCases.map((id) => Number(/^draw-credit-(\d+)-/.exec(id)?.[1] ?? 0))
          ) + 1
        : 121;
    // Prove small seed circuits in bounded batches; settlement remains sequential normal transactions.
    for (let offset = 0; offset < seedCount; offset += 3) {
        const batch = await Promise.all(
            Array.from({ length: Math.min(3, seedCount - offset) }, async () => {
                const p = await createSeed();
                const request = await p.exportWalletAuthorization();
                return (
                    await p.withWalletSignature(
                        await signer.signTypedData(request.domain, request.types, request.message)
                    )
                ).prove();
            })
        );
        for (const ready of batch) {
            const call = await ready.exportTransaction(),
                receipt = await (
                    await signer.sendTransaction({ ...call, gasLimit: blockGasLimit - 1n })
                ).wait();
            if (receipt.status !== 1) throw Error("Seed reverted");
            setupReceipts.push({ kind: "seed-credit", ...receipt.toJSON() });
            await append(receipt);
            fresh.push(await readCredit(receipt));
        }
        guard();
        console.log(`Seed Credits ${fresh.length}/${seedCount}`);
    }
    const usageSeed = fresh.pop();
    const consumed = await complete(
        await invisi.prepareDrawCredit({
            wallet: PublicWallet.fromAddress(bob.getAddress()),
            protocol,
            tokenAddress,
            creditInputs: [{ ...usageSeed, role: "spender" }],
            credits: [{ credit: usageSeed.commitment, amount: 10n }],
        })
    );
    await append(consumed.receipt);
    const drawn = events(consumed.receipt).find((e) => e.name === "CreditDraw"),
        usedCommitment = drawn.args.params.remainderCommitments[0],
        usedState = await wallet.getViewer().decryptCredit(drawn.args.deliveries[0].ciphertext, {
            chainId: 31337n,
            protocolAddress: BigInt(instance),
            tokenAddress: BigInt(tokenAddress),
            outputCommitment: BigInt(usedCommitment),
            role: "owner",
        });
    const used = {
        state: usedState,
        commitment: usedCommitment,
        treeId: 1n,
        leafIndex: Number(drawn.args.remainderLeafIndices[0]),
        role: "owner",
    };
    if (usedState.note.dailySpent !== 10n || usedState.note.monthlySpent !== 10n)
        throw Error("Missing nonzero setup usage");
    const bobSigner = new EvmWallet("0x" + "02".repeat(32), provider);
    await (await signer.sendTransaction({ to: bob.ownerAddress, value: 10n ** 18n })).wait();
    await (
        await token.connect(bobSigner).transfer(account, await token.balanceOf(bob.ownerAddress))
    ).wait();
    await (await token.approve(instance, 100n)).wait();
    const baseline = {
        leafCount: tree.size,
        treeId: "1",
        ownerTokenBalance: String(await token.balanceOf(account)),
        spenderTokenBalance: String(await token.balanceOf(bob.ownerAddress)),
        allowance: String(await token.allowance(account, instance)),
        contractTokenBalance: String(await token.balanceOf(instance)),
        timestamp: String((await provider.getBlock("latest")).timestamp),
    };
    if (baseline.spenderTokenBalance !== "0") throw Error("Payout baseline must be zero");
    guard();
    const base = { wallet: PublicWallet.fromAddress(wallet.getAddress()), protocol, tokenAddress },
        cases = [
            {
                id: "create-credit-caller-0x0",
                prepare: (deadline) =>
                    invisi.prepareCreateCredit({
                        ...base,
                        inputs: [],
                        spender: bob.getAddress(),
                        amount: 100n,
                        expiry,
                        deadline,
                        singleLimit: 100n,
                        dailyLimit: 200n,
                        monthlyLimit: 300n,
                        funding: { payer: account, amount: 100n, authorization: "caller" },
                    }),
            },
            {
                id: "create-credit-1x1",
                prepare: (deadline) =>
                    invisi.prepareCreateCredit({
                        ...base,
                        inputs,
                        spender: bob.getAddress(),
                        amount: 100n,
                        expiry,
                        deadline,
                        singleLimit: 100n,
                        dailyLimit: 200n,
                        monthlyLimit: 300n,
                    }),
            },
            ...[1, 12, 50, 120].flatMap((count) =>
                [false, true].map((full) => ({
                    id: `draw-credit-${count}-${full ? "full" : "partial"}`,
                    prepare: (deadline) =>
                        invisi.prepareDrawCredit({
                            ...base,
                            wallet: PublicWallet.fromAddress(bob.getAddress()),
                            creditInputs: fresh
                                .slice(0, count)
                                .map((c) => ({ ...c, role: "spender" })),
                            credits: fresh
                                .slice(0, count)
                                .map((c) => ({ credit: c.commitment, amount: full ? 100n : 30n })),
                            deadline,
                        }),
                }))
            ),
            ...[false, true].map((changed) => ({
                id: `top-up-credit-1x1-${changed ? "changed-limits" : "unchanged-limits"}`,
                policy: changed ? { singleLimit: 50n, dailyLimit: 5n, monthlyLimit: 0n } : null,
                prepare: (deadline) =>
                    invisi.prepareTopUpCredit({
                        ...base,
                        inputs,
                        creditInputs: [used],
                        credit: used.commitment,
                        additionalAmount: 80n,
                        expiry,
                        deadline,
                        ...(changed ? { singleLimit: 50n, dailyLimit: 5n, monthlyLimit: 0n } : {}),
                    }),
            })),
            {
                id: "cancel-credit-1",
                prepare: (deadline) =>
                    invisi.prepareCancelCredit({
                        ...base,
                        creditInputs: [used],
                        credit: used.commitment,
                        deadline,
                    }),
            },
        ];
    const selected = process.env.GAS_BENCHMARK_CASES?.split(",");
    if (selected?.some((id) => !cases.some((c) => c.id === id)))
        throw Error("Unknown benchmark case");
    const profile = {
        formatVersion: 1,
        id: `protocol-${revision.slice(0, 7)}-${initialSources.sha256.slice(0, 12)}-prague-credit-real`,
        deployment: {
            chainId: "31337",
            protocolAddress: instance,
            runtimeCodeHash: runtimeContracts.InvisiProtocol.runtimeCodeHash,
            tokenAddress,
        },
        source: {
            protocolCommit: revision,
            measuredAt: new Date().toISOString(),
            chain: "Anvil 31337",
            hardfork: "prague",
            token: "MockERC20",
            verifier: "real",
            fingerprints: {
                protocolSourceSha256: initialSources.sha256,
                dirtyDiffSha256,
                compiledArtifactsSha256: "",
                creditManifestSha256: sha256(
                    readFileSync(join(protocolRoot, "circuits/credit-manifest.json"))
                ),
                userManifestSha256: sha256(
                    readFileSync(join(protocolRoot, "circuits/transact-user-manifest.json"))
                ),
                sdkSourceSha256: sdkSources.sha256,
            },
            toolchain: {
                solidity: "0.8.38",
                barretenberg: "6.0.0",
                noir: readFileSync(join(protocolRoot, ".nargo-version"), "utf8").trim(),
                evmVersion: "prague",
                optimizerRuns: 200,
                anvil: execFileSync("anvil", ["--version"]).toString().split("\n")[0],
            },
            blockGasLimit: String(blockGasLimit),
            runtimeContracts,
            assumptions: [
                "normal CREATE/Factory deployment and fresh registry; EIP170/EIP3860 unchanged; no code/storage injection",
                "Solidity0.8.38 optimizer200 Prague; pinned BB6.0.0 real verifiers; every native proof independently verified",
                `one physical source tree and ${seedCount + 2} existing leaves shared by every sample; top-up has two authenticated source groups; no rollover or screener`,
                `funding/approvals/${seedCount} genuine Credit seeds/usage-seed draw/payout reset excluded from business gas`,
                "each round restores identical token balances, exact caller allowance100, note cursor, nullifiers and baseline; spender payout starts zero",
                "complete receipt.gasUsed is measured, including verifier/calldata/logging/output insertion; memo0",
                "Prague local block gas limit500000000; measured transactions may be unmineable under lower network transaction/block limits",
                "observed three-sample ranges are neither a confidence interval nor a recommended transaction gas limit",
            ],
        },
        measurements: [],
    };
    let snapshot = await provider.send("evm_snapshot", []);
    for (const scenario of cases.filter((c) => !selected || selected.includes(c.id))) {
        const measurement = { id: scenario.id, shape: null, circuit: null, samples: [] };
        for (let round = 0; round < 3; round++) {
            guard();
            if (!(await provider.send("evm_revert", [snapshot])))
                throw Error("Snapshot restore failed");
            snapshot = await provider.send("evm_snapshot", []);
            const deadline = BigInt(baseline.timestamp) + 3600n + BigInt(round);
            const prepared = await scenario.prepare(deadline),
                review = prepared.preview();
            const { ready, call, receipt, proof, timings } = await complete(prepared, true);
            if (!proof) throw Error("Credit proof required");
            const released = credit.entries.find((e) => e.name === proof.circuitName);
            if (
                !released ||
                proof.artifactSha256 !== released.artifactSha256 ||
                proof.vkSha256 !== released.direct.vkSha256
            )
                throw Error("SDK proof differs from authenticated current release");
            const parsed = contract.interface.parseTransaction({ data: call.data }),
                args = parsed.args,
                p = parsed.name === "topUpCredit" ? args[1].creation : args[1],
                deliveries = parsed.name === "cancelCredit" ? [] : args[2];
            const draw = parsed.name === "creditDraw",
                cancel = parsed.name === "cancelCredit",
                top = parsed.name === "topUpCredit",
                funding = draw || cancel ? null : args[3];
            const shape = {
                kind: review.kind,
                target: proof.target,
                capacity: review.capacity ?? 0,
                noteInputs: draw || cancel ? 0 : p.nullifiers.length,
                noteOutputs: draw || cancel ? 0 : Number(BigInt(p.changeCommitment) !== 0n),
                sourceTrees: cancel ? 1 : p.sources.length + (top ? 1 : 0),
                creditInputs: draw ? p.nullifiers.length : cancel || top ? 1 : 0,
                creditOutputs: review.creditOutputs?.length ?? 0,
                creditRemainders: draw
                    ? p.remainderCommitments.filter((h) => BigInt(h) !== 0n).length
                    : 0,
                funding:
                    funding && funding.amount > 0n
                        ? funding.signature !== "0x"
                            ? "signature"
                            : "caller"
                        : "none",
                permit: !!funding && funding.permit.deadline !== 0n,
                deliveryBytes: deliveries.reduce(
                    (sum, d) => sum + (d.ciphertext.length - 2) / 2 + (d.clue.length - 2) / 2,
                    0
                ),
            };
            const identity = {
                circuitName: proof.circuitName,
                target: proof.target,
                artifactSha256: proof.artifactSha256,
                vkSha256: proof.vkSha256,
            };
            if (measurement.shape && JSON.stringify(shape) !== JSON.stringify(measurement.shape))
                throw Error("Sample shape changed");
            measurement.shape = shape;
            measurement.circuit = identity;
            const inserted = events(receipt).find((e) => e.name === "CommitmentsInserted");
            if (inserted && Number(inserted.args.startLeafIndex) !== baseline.leafCount)
                throw Error("Append cursor baseline differs");
            let policyEvidence = null;
            if (top) {
                const created = events(receipt).find((e) => e.name === "CreditToppedUp"),
                    child = await wallet
                        .getViewer()
                        .decryptCredit(created.args.deliveries[0].ciphertext, {
                            chainId: 31337n,
                            protocolAddress: BigInt(instance),
                            tokenAddress: BigInt(tokenAddress),
                            outputCommitment: BigInt(created.args.params.creation.creditCommitment),
                            role: "owner",
                        });
                for (const key of ["lastDay", "dailySpent", "lastMonth", "monthlySpent"])
                    if (child.note[key] !== usedState.note[key]) throw Error("Topup reset usage");
                for (const key of ["singleLimit", "dailyLimit", "monthlyLimit"])
                    if (child.note[key] !== (scenario.policy?.[key] ?? usedState.note[key]))
                        throw Error("Topup policy mismatch");
                policyEvidence = {
                    previous: Object.fromEntries(
                        [
                            "singleLimit",
                            "dailyLimit",
                            "monthlyLimit",
                            "lastDay",
                            "dailySpent",
                            "lastMonth",
                            "monthlySpent",
                        ].map((k) => [k, usedState.note[k]])
                    ),
                    next: Object.fromEntries(
                        [
                            "singleLimit",
                            "dailyLimit",
                            "monthlyLimit",
                            "lastDay",
                            "dailySpent",
                            "lastMonth",
                            "monthlySpent",
                        ].map((k) => [k, child.note[k]])
                    ),
                };
            }
            const sample = {
                gasUsed: String(receipt.gasUsed),
                transactionHash: receipt.hash,
                blockNumber: String(receipt.blockNumber),
                blockHash: receipt.blockHash,
                calldataBytes: (call.data.length - 2) / 2,
            };
            measurement.samples.push(sample);
            const block = await provider.getBlock(receipt.blockNumber),
                transaction = await provider.getTransaction(receipt.hash),
                raw = await provider.send("eth_getRawTransactionByHash", [receipt.hash]);
            samplesEvidence.push({
                case: scenario.id,
                round: round + 1,
                sample,
                receipt: receipt.toJSON(),
                transaction: transaction.toJSON(),
                rawTransaction: raw,
                block: block.toJSON(),
                proof: {
                    circuitName: proof.circuitName,
                    target: proof.target,
                    artifactSha256: proof.artifactSha256,
                    vkSha256: proof.vkSha256,
                    proofSha256: proof.proofSha256,
                    publicInputs: proof.publicInputs,
                },
                policy: policyEvidence,
                timings,
            });
            console.log(
                `${scenario.id} ${round + 1}/3: ${receipt.gasUsed} gas; ${sample.calldataBytes} calldata bytes`
            );
            writeFileSync(
                join(evidenceDir, "progress.json"),
                stringify({ profile, measurement, baseline, setupReceipts, samplesEvidence })
            );
        }
        profile.measurements.push(measurement);
    }
    guard();
    profile.source.fingerprints.compiledArtifactsSha256 = fingerprintFiles(protocolRoot, [
        ...usedArtifacts.keys(),
    ]).sha256;
    const evidence = {
        profile,
        baseline,
        sourceFiles: initialSources.files,
        sdkSourceFiles: sdkSources.files,
        compiledArtifacts: Object.fromEntries(usedArtifacts),
        setupReceipts,
        samplesEvidence,
    };
    writeFileSync(join(evidenceDir, "evidence.json"), stringify(evidence));
    if (selected) {
        const partial = output + ".partial";
        writeFileSync(partial, stringify([profile]));
        console.log(`Partial matrix written only to ${partial}; full catalog untouched`);
    } else {
        if (
            profile.measurements.length !== 13 ||
            profile.measurements.some((m) => m.samples.length !== 3)
        )
            throw Error("Incomplete Credit matrix");
        const previous = JSON.parse(readFileSync(output, "utf8")),
            funds = previous
                .map((p) => ({
                    ...p,
                    measurements: p.measurements.filter(
                        (m) =>
                            ![
                                "create-credit",
                                "draw-credit",
                                "top-up-credit",
                                "cancel-credit",
                            ].includes(m.shape.kind)
                    ),
                }))
                .filter((p) => p.measurements.length);
        const temporary = output + ".tmp";
        writeFileSync(temporary, stringify([profile, ...funds]));
        guard();
        renameSync(temporary, output);
        console.log(
            `Atomically saved13 current Credit cases and historical Funds only to ${output}`
        );
    }
    console.log(`Evidence ${join(evidenceDir, "evidence.json")}`);
} finally {
    provider?.destroy();
    anvil.kill("SIGTERM");
}
