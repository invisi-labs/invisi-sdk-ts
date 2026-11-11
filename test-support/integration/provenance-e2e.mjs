/**
 * Local integration acceptance: node test-support/integration/provenance-e2e.mjs --sdk --browser --reorg
 * Runs real chains, services, proofs and browsers with public local test assets.
 * Requires current protocol/provenance releases, CRS, built web assets, Chrome and SDK toolchains.
 * --replicas requires PROVENANCE_TEST_PG_DSN and uses an isolated temporary schema.
 * --keep retains owned processes until SIGINT; otherwise only owned processes are cleaned up.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createPublicKey } from "node:crypto";
import { ZeroAddress, ZeroHash, keccak256 } from "ethers";
import { root, json, sha } from "../../../invisi-protocol/scripts/provenance-build.mjs";
import { createSettlementRuntime } from "../../../invisi-protocol/scripts/settlement-fixtures/runtime.mjs";
import {
    prepareSettlementShield,
    settlementDirectRequest,
} from "../../../invisi-protocol/scripts/settlement-fixtures/client.mjs";
import { fixtureWallet } from "../../../invisi-protocol/scripts/fixture-utils.mjs";
import { createTransactSlotsFixture } from "../../../invisi-protocol/scripts/transact-slots-fixtures.mjs";
import { noteCommitment } from "../../../invisi-protocol/scripts/private-transfer-client.mjs";
import { buildNoteTree } from "../../../invisi-protocol/scripts/note-tree-fixtures.mjs";
import { proveUserNative } from "../../../invisi-protocol/scripts/transact-user-pipeline.mjs";
import {
    buildWitness,
    scopeHash,
    recognizedLeaf,
    RecognizedTree,
    operationDigest,
    verifyRootCertificate,
} from "../../../invisi-protocol/scripts/provenance-client.mjs";
import { rejectRecoveryProof, recoveryFixture } from "./provenance-e2e-recovery.mjs";
import { startReplicas } from "./provenance-e2e-replicas.mjs";
import { reorgScenario } from "./provenance-e2e-reorg.mjs";
import { browserScenario } from "./provenance-e2e-browser.mjs";
import { creditScenario } from "./provenance-e2e-credit.mjs";
import {
    proveWitness,
    trustedManifest,
} from "../../../invisi-protocol/scripts/provenance-proof.mjs";
import { preflightTracking, trackedRecognition } from "./provenance-e2e-tracking.mjs";

const options = {};
for (const arg of process.argv.slice(2)) {
    if (
        arg === "--keep" ||
        arg === "--chain-only" ||
        arg === "--browser" ||
        arg === "--details" ||
        arg === "--reorg" ||
        arg === "--sdk" ||
        arg === "--replicas" ||
        arg === "--recovery"
    ) {
        options[arg.slice(2)] = true;
        continue;
    }
    const m = arg.match(/^--(output|service-port|rpc-port)=(.+)$/);
    assert(m, "unknown option " + arg);
    assert(!Object.hasOwn(options, m[1]), "duplicate option");
    options[m[1]] = m[2];
}
const directory = resolve(
        options.output ?? join(root, ".tools/provenance-e2e/runs", String(Date.now()))
    ),
    repoRoot = resolve(root, ".."),
    rpcRoot = join(repoRoot, "invisi-protocol-rpc"),
    serviceRoot = join(repoRoot, "invisi-provenance"),
    bin = join(directory, "bin");
mkdirSync(bin, { recursive: true });
const save = (name, value) => writeFileSync(join(directory, name), json(value), { mode: 0o600 });
const children = [];
let runtime;
let replicas;
let invalidRecoveryJob;
let successful = false;
let stage = "build";
const report = {
    format: "invisi.provenance.e2e.v1",
    startedAt: new Date().toISOString(),
    realChain: true,
    realProtocolVerifiers: true,
    realProtocolRPC: false,
    realNativeProvenanceVerifier: false,
    proofMocks: false,
    stages: [],
};
function step(name, data = {}) {
    stage = name;
    console.log(name);
    report.stages.push({ name, at: new Date().toISOString(), ...data });
    save("report.json", report);
}
function run(command, args, cwd) {
    const r = spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 64 << 20,
        env: { ...process.env, HARDWARE_CONCURRENCY: "4", BB_MSM_LEGACY: "1" },
    });
    if (r.status !== 0) throw Error(`${command} ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
    return r;
}
function start(command, args, cwd, label) {
    const fd = openSync(join(directory, label + ".log"), "w", 0o600),
        p = spawn(command, args, {
            cwd,
            stdio: ["ignore", fd, fd],
            env: {
                ...process.env,
                HARDWARE_CONCURRENCY: "4",
                BB_MSM_LEGACY: "1",
                INVISI_PROVENANCE_LIVE: "1",
                INVISI_PROVENANCE_TRUST: join(directory, "sdk-trust.json"),
            },
        });
    closeSync(fd);
    p.on("error", (error) => console.error(label + ": " + error.message));
    children.push(p);
    return p;
}
async function stop(p) {
    if (!p || p.exitCode !== null || p.signalCode !== null || p.pid === undefined) return;
    const done = new Promise((r) => p.once("exit", r));
    p.kill("SIGTERM");
    const timer = setTimeout(() => p.kill("SIGKILL"), 5000);
    try {
        await done;
    } finally {
        clearTimeout(timer);
    }
}
async function port(preferred) {
    const n = preferred === undefined ? 0 : Number(preferred);
    assert(Number.isInteger(n) && n >= 0 && n <= 65535, "invalid port");
    const server = createServer();
    await new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(n, "127.0.0.1", res);
    });
    const value = server.address().port;
    await new Promise((res) => server.close(res));
    return value;
}
let requestID = 0;
async function rpc(url, method, params = []) {
    const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++requestID, method, params }),
    });
    const b = await res.json();
    if (b.error) throw Error(method + ": " + JSON.stringify(b.error));
    assert(b.result !== undefined, method + " missing result");
    return b.result;
}
async function until(label, fn, { timeout = 90000 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        for (const p of children)
            if (p.exitCode !== null) throw Error(label + ": service process exited " + p.exitCode);
        try {
            const value = await fn();
            if (value) return value;
        } catch (e) {
            last = e;
        }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw Error(label + " timeout" + (last ? ": " + last.message : ""));
}
const fingerprint = (path) => sha(readFileSync(path));
try {
    if (!options["chain-only"]) {
        step("build-real-services");
        run("go", ["build", "-mod=readonly", "-o", join(bin, "protocol-rpc"), "./cmd"], rpcRoot);
        run(
            "go",
            ["build", "-mod=readonly", "-o", join(bin, "provenance"), "./cmd/provenance"],
            serviceRoot
        );
        report.serviceBinaries = {
            protocolRPCSha256: fingerprint(join(bin, "protocol-rpc")),
            provenanceSha256: fingerprint(join(bin, "provenance")),
        };
    }
    step("deploy-complete-real-main-release");
    runtime = await createSettlementRuntime({
        root,
        directory: join(directory, "chain"),
        timestamp: "wall-clock",
    });
    const { context, tokens, sender, protocol, proto, token, tx, call } = runtime;
    const deployment = JSON.parse(readFileSync(join(directory, "chain/deployment.json"))),
        protocolDeployment = deployment.deployments.find((d) => d.name === "InvisiProtocol"),
        codeHash = keccak256(await runtime.rpc("eth_getCode", [protocol, "latest"])),
        fromBlock = Number(BigInt(protocolDeployment.receipt.blockNumber));
    save("runtime.json", {
        chainRPC: JSON.parse(readFileSync(join(directory, "chain/node.json"))).url,
        protocolAddress: protocol,
        runtimeCodeHash: codeHash,
        fromBlock,
        chainId: "31337",
    });
    const amount = 100000000000000000n,
        wallet = await fixtureWallet(1),
        recipientWallet = await fixtureWallet(2),
        sourceNote = {
            ownerAddress: wallet.ownerAddress,
            amount,
            nonce: 424242n,
            treeId: 1n,
        },
        outputNote = {
            ownerAddress: recipientWallet.ownerAddress,
            amount,
            nonce: 424243n,
        };
    const permit = { deadline: 0n, v: 0, r: ZeroHash, s: ZeroHash },
        funding = (value) => ({
            payer: value ? sender : ZeroAddress,
            amount: value,
            sigNonce: 0n,
            deadline: 0n,
            signature: "0x",
            permit,
        });
    await tx("mint", tokens[0], token.encodeFunctionData("mint", [sender, amount * 10n]));
    await tx(
        "approve",
        tokens[0],
        token.encodeFunctionData("approve", [protocol, (1n << 256n) - 1n])
    );
    step("real-shield-and-token-receipt");
    const shieldRequest = await prepareSettlementShield(context, [sourceNote], {
            wallet,
            deadline: context.timestamp + 86400n,
            funding: funding(amount),
        }),
        shieldReceipt = await tx(
            "shield",
            protocol,
            proto.encodeFunctionData("shield", [
                shieldRequest.params,
                shieldRequest.outputs,
                shieldRequest.deliveries,
                shieldRequest.funding,
            ])
        ),
        sourceC = await noteCommitment(context, sourceNote);
    assert.equal(BigInt(await call(token, tokens[0], "balanceOf", [protocol])), amount);
    assert.equal(BigInt(await call(token, tokens[0], "balanceOf", [sender])), amount * 9n);
    assert.equal(
        await call(proto, protocol, "isCommitmentRegistered", [
            shieldRequest.params.noteCommitments[0],
        ]),
        true
    );
    assert.equal(BigInt(await call(proto, protocol, "getNoteTreeNextLeafIndex", [1])), 1n);
    const mainTree = await buildNoteTree([sourceC]);
    assert.equal(
        BigInt(await call(proto, protocol, "getNoteTreeRoot", [1])),
        BigInt(mainTree.root)
    );
    save("shield-facts.json", {
        transactionHash: shieldReceipt.transactionHash,
        blockHash: shieldReceipt.blockHash,
        blockNumber: String(BigInt(shieldReceipt.blockNumber)),
        payer: sender,
        token: tokens[0],
        amount,
        commitment: shieldRequest.params.noteCommitments[0],
        poolBalance: amount,
        mainTreeRoot: mainTree.root,
    });
    const snapshot = await runtime.rpc("evm_snapshot", []);
    step("prove-real-main-private-transact-c2");
    const fixture = await createTransactSlotsFixture(1, 1, {
            context,
            wallet,
            sourceNotes: [sourceNote],
            sourceTrees: [{ treeId: 1n, depositCommitments: [sourceC] }],
            outputNotes: [outputNote],
            outputWallets: [recipientWallet],
            funding: funding(0n),
            deadline: context.timestamp + 86400n,
        }),
        mainBundle = await proveUserNative(fixture, {
            root,
            directory: join(directory, "main-proof"),
            mode: "direct",
            threads: 4,
        }),
        request = settlementDirectRequest(fixture),
        direct = proto.fragments.find(
            (f) =>
                f.type === "function" && f.name === "transact" && f.inputs[1].baseType === "tuple"
        ),
        data = proto.encodeFunctionData(direct, [mainBundle.proofHex, request]);
    assert.equal(mainBundle.profile.capacity, 2);
    const operationHash = operationDigest({
        chainId: context.chainId,
        protocolAddress: protocol,
        operationKind: 2,
        mainCircuitCapacity: 2,
        publicInputs: mainBundle.publicInputs,
    });
    save("private-calldata.json", {
        data,
        operationDigest: operationHash,
        mainCapacity: 2,
        publicInputs: mainBundle.publicInputs,
        noteNullifiers: fixture.params.nullifiers,
        noteOutputs: fixture.params.noteCommitments,
    });
    save("synthetic-wallet-fixture.json", {
        nonsecretPublicTestSeeds: true,
        sourceNote,
        outputNote,
        context,
    });
    let sourceBundle, cert, serviceURL, trackingPreflight;
    if (!options["chain-only"]) {
        step("start-real-protocol-rpc");
        const rpcPort = await port(options["rpc-port"]),
            rpcDir = join(directory, "protocol-rpc");
        run(
            join(bin, "protocol-rpc"),
            ["init", "--dir", rpcDir, "--listen", `127.0.0.1:${rpcPort}`],
            rpcRoot
        );
        const rpcConfig = {
            listen: `127.0.0.1:${rpcPort}`,
            maxConcurrentRequests: 16,
            chains: [
                {
                    chainRpc: JSON.parse(readFileSync(join(directory, "chain/node.json"))).url,
                    database: { driver: "sqlite", path: join(rpcDir, "protocol.sqlite") },
                    confirmations: 0,
                    pollSeconds: 1,

                    snapshotInterval: "0s",
                    deployment: {
                        chainId: "31337",
                        protocol: {
                            address: protocol,
                            runtimeCodeHash: codeHash,
                            fromBlock,
                        },
                    },
                },
            ],
        };
        writeFileSync(join(rpcDir, "config.json"), json(rpcConfig), {
            mode: 0o600,
        });
        const rpcProcess = start(
            join(bin, "protocol-rpc"),
            ["run", "--dir", rpcDir],
            rpcRoot,
            "protocol-rpc"
        );
        const protocolRPC = `http://127.0.0.1:${rpcPort}/v1/chains/31337`;
        report.realProtocolRPC = true;
        await until("protocol RPC canonical Shield indexing", async () => {
            const status = await rpc(protocolRPC, "invisi_getStatus");
            return status.indexedHead?.number >= Number(BigInt(shieldReceipt.blockNumber))
                ? status
                : null;
        });
        step("start-real-provenance-with-pinned-native-verifier");
        const servicePort = await port(options["service-port"]),
            serviceDir = join(directory, "provenance");
        run(join(bin, "provenance"), ["-dir", serviceDir, "init"], serviceRoot);
        const cfg = JSON.parse(readFileSync(join(serviceDir, "config.json"))),
            riskID = "0x" + sha("owned-real-e2e-address-list"),
            rules = {
                mode: "address-only",
                requiredProviders: [riskID],
                confirmations: "0",
                waitSeconds: "0",
            };
        const manifest = trustedManifest();
        const crsPath = join(root, ".tools/provenance-verifier-crs");
        assert(
            existsSync(join(crsPath, "pins.json")),
            "preprovisioned CRS missing: run node ../invisi-protocol/scripts/provenance-crs.mjs"
        );
        const pins = JSON.parse(readFileSync(join(crsPath, "pins.json"))).files;
        Object.assign(cfg, {
            listen: `127.0.0.1:${servicePort}`,
            role: "all",
            webDir: join(serviceRoot, "web/dist"),
            database: {
                driver: "sqlite",
                dsn: join(serviceDir, "provenance.sqlite"),
                singleProcess: true,
            },
            rules,
            providers: [
                {
                    id: riskID,
                    mode: "address-only",
                    addressListFile: "address-list.json",
                    timeoutSeconds: "5",
                },
            ],
            chains: [
                {
                    chainId: "31337",
                    protocolAddress: protocol.toLowerCase(),
                    codeHash,
                    startBlock: String(fromBlock),
                    protocolRpc: protocolRPC,
                    chainRpc: JSON.parse(readFileSync(join(directory, "chain/node.json"))).url,
                    name: "Owned Anvil",
                    environment: "testnet",
                },
            ],
            verifier: {
                manifestPath: join(root, "circuits/provenance/manifest.json"),
                trustedManifestSha256: manifest.manifestSha256,
                releaseRoot: root,
                bbPath: join(root, ".tools/bb/bb"),
                bbSha256: fingerprint(join(root, ".tools/bb/bb")),
                crsPath,
                crsSha256: { "bn254_g1.dat": pins["bn254_g1.dat"] },
                bn254G2Sha256: pins["bn254_g2.dat"],
                timeoutSeconds: "30",
                maxConcurrent: "2",
                queueLimit: "8",
                maxMemoryBytes: String(512 << 20),
                maxCpuSeconds: "32",
                tempDir: join(serviceDir, "verify-temp"),
            },
        });
        mkdirSync(cfg.verifier.tempDir, { recursive: true, mode: 0o700 });
        writeFileSync(join(serviceDir, "config.json"), json(cfg), { mode: 0o600 });
        let serviceProcess;
        if (options.replicas) {
            replicas = await startReplicas({
                cfg,
                serviceDir,
                directory,
                binary: join(bin, "provenance"),
                serviceRoot,
                port,
                start,
                stop,
                untrack: (process) => {
                    const i = children.indexOf(process);
                    if (i >= 0) children.splice(i, 1);
                },
                until,
                rpc,
                save,
                step,
            });
            serviceURL = replicas.apiURLs[0];
            serviceProcess = replicas.apiProcesses[0];
        } else {
            serviceProcess = start(
                join(bin, "provenance"),
                ["-dir", serviceDir, "run"],
                serviceRoot,
                "provenance"
            );
            serviceURL = `http://127.0.0.1:${servicePort}/v1/chains/31337`;
        }
        save("services.json", {
            protocolRPC,
            provenanceRPC: serviceURL,
            explorer: `http://127.0.0.1:${servicePort}/api/v1`,
            protocolRPCPid: rpcProcess.pid,
            provenancePid: serviceProcess.pid,
            ...(replicas
                ? { replicaAPIs: replicas.apiURLs, replicaProcesses: replicas.record }
                : {}),
            providerId: cfg.providerId,
            signingPublicKey: cfg.signingPublicKey,
            manifestSha256: manifest.manifestSha256,
        });
        await until("native worker healthy", async () => {
            const s = await rpc(serviceURL, "provenance_getStatus");
            return s.workerAvailable ? s : null;
        });
        const recognized = await until("Shield signed recognition", async () => {
            const r = await rpc(serviceURL, "provenance_getOperationRecognition", [
                {
                    blockHash: shieldReceipt.blockHash,
                    txHash: shieldReceipt.transactionHash,
                    operationIndex: "0",
                },
            ]);
            return r.recognitionState === "recognized" ? r : null;
        });
        save("shield-recognition.json", recognized);
        const roots = await rpc(serviceURL, "provenance_getRoots", [{ after: "0", limit: "20" }]);
        cert = roots.items[0];
        assert(cert && cert.rootSequence === "1");
        assert.equal(cert.providerId, cfg.providerId);
        const trustedKey = createPublicKey({
            key: Buffer.concat([
                Buffer.from("302a300506032b6570032100", "hex"),
                Buffer.from(cfg.signingPublicKey.slice(2), "hex"),
            ]),
            format: "der",
            type: "spki",
        });
        assert(
            verifyRootCertificate(cert, cert.signature, trustedKey),
            "root signature must authenticate against locally configured key"
        );
        const anchor = await runtime.rpc("eth_getBlockByNumber", [
            "0x" + BigInt(cert.confirmedBlockNumber).toString(16),
            false,
        ]);
        assert.equal(anchor.hash, cert.confirmedBlockHash);
        step("sync-public-leaves-and-prove-real-provenance-k10");
        const leaves = await rpc(serviceURL, "provenance_getLeaves", [
                {
                    rootId: `${cert.chainGeneration}:${cert.rootSequence}`,
                    fromIndex: "0",
                    limit: "200",
                },
            ]),
            tree = new RecognizedTree();
        for (const n of leaves.items) await tree.append(BigInt(n.leaf));
        assert.equal(tree.leaves.length, Number(BigInt(cert.leafCount)));
        const scope = await scopeHash({
                chainId: context.chainId,
                protocolAddress: protocol,
            }),
            leaf = await recognizedLeaf(scope, sourceC),
            index = tree.leaves.findIndex((x) => x === leaf);
        assert(index >= 0);
        const path = await tree.path(index);
        assert.equal(path.root, BigInt(cert.root));
        const witness = await buildWitness({
            capacity: 10,
            chainId: context.chainId,
            protocolAddress: protocol,
            tokenAddress: tokens[0],
            chainGeneration: BigInt(cert.chainGeneration),
            operationDigest: operationHash,
            inputs: [
                {
                    owner: sourceNote.ownerAddress,
                    nonce: sourceNote.nonce,
                    amount: sourceNote.amount,
                    sourceIndex: 0,
                    leafIndex: index,
                    path: path.path,
                },
            ],
            sources: [{ treeId: cert.treeId, root: cert.root, leafCount: cert.leafCount }],
        });
        const raw = proveWitness(witness, 10, join(directory, "provenance-proof"));
        sourceBundle = {
            format: "invisi-provenance-proof-v1",
            circuitId: "provenance_k10",
            manifestSha256: raw.manifestSha256,
            target: "evm",
            publicInputs: raw.publicInputs,
            proof: raw.proofHex,
            rootCertificates: [cert],
        };
        save("source-sidecar.json", sourceBundle);
        step("persist-real-preflight-tracking-before-onchain-settlement");
        const preflights = await Promise.all(
            (replicas ? replicas.apiURLs : [serviceURL]).map((endpoint) =>
                preflightTracking({
                    rpc,
                    serviceURL: endpoint,
                    data,
                    sourceBundle,
                    operationHash,
                })
            )
        );
        trackingPreflight = preflights[0];
        assert(
            preflights.every((value) => value.tracking.id === trackingPreflight.tracking.id),
            "concurrent preflights deduplicate across replicas"
        );
        save("private-tracking-preflight.json", trackingPreflight);
    }
    step("settle-real-main-private-transact");
    const privateReceipt = await tx("private-transact", protocol, data);
    assert.equal(
        await call(proto, protocol, "isNullifierSpent", [fixture.params.nullifiers[0]]),
        true
    );
    assert.equal(
        await call(proto, protocol, "isCommitmentRegistered", [fixture.params.noteCommitments[0]]),
        true
    );
    assert.equal(BigInt(await call(token, tokens[0], "balanceOf", [protocol])), amount);
    assert.equal(BigInt(await call(proto, protocol, "getNoteTreeNextLeafIndex", [1])), 2n);
    const expectedMain = await buildNoteTree([sourceC, ...fixture.params.noteCommitments]);
    assert.equal(
        BigInt(await call(proto, protocol, "getNoteTreeRoot", [1])),
        BigInt(expectedMain.root)
    );
    save("private-chain-facts.json", {
        transactionHash: privateReceipt.transactionHash,
        blockHash: privateReceipt.blockHash,
        status: privateReceipt.status,
        inputNullifierSpent: true,
        outputRegistered: true,
        poolBalance: amount,
        mainTreeRoot: expectedMain.root,
    });
    if (!options["chain-only"]) {
        step("automatically-recognize-preflight-tracked-private-operation");
        const tracked = await trackedRecognition({
            rpc,
            until,
            serviceURL,
            tracking: trackingPreflight.tracking,
            operationHash,
            receipt: privateReceipt,
        });
        assert.equal(tracked.checkpointSequence, "2");
        save("private-tracking-recognized.json", tracked);
        const completedPreflight = await preflightTracking({
            rpc,
            serviceURL,
            data,
            sourceBundle,
            operationHash,
        });
        assert.equal(
            completedPreflight.tracking.id,
            tracked.id,
            "completed candidate reuses its persistent tracking acknowledgement"
        );
        assert.deepEqual(completedPreflight.tracking.matched, tracked.matched);
        assert.equal(completedPreflight.tracking.checkpointSequence, tracked.checkpointSequence);
        save("tracking-completed-preflight.json", completedPreflight);
        const operation = await rpc(serviceURL, "provenance_getOperationRecognition", [
            {
                blockHash: privateReceipt.blockHash,
                txHash: privateReceipt.transactionHash,
                operationIndex: "0",
            },
        ]);
        assert.equal(operation.recognitionState, "recognized");
        assert.equal(operation.operation.operationDigest, operationHash);
        assert.deepEqual(
            operation.operation.publicInputs.map(BigInt),
            mainBundle.publicInputs.map(BigInt)
        );
        if (options.recovery)
            invalidRecoveryJob = await rejectRecoveryProof({
                serviceURL,
                privateReceipt,
                sourceBundle,
                rpc,
                until,
                save,
                step,
            });
        const verifiedJobID = operation.recognition?.proofJobId;
        report.realNativeProvenanceVerifier = true;
        report.automaticTracking = true;
        report.trackingId = trackingPreflight.tracking.id;
        report.manualConfirmedProofSubmissions = options.recovery ? 1 : 0;
        report.manualValidConfirmedProofSubmissions = 0;
        report.explicitInvalidJobImport = !!options.recovery;
        const child = await until("successor Note signed recognition", async () => {
            const n = await rpc(serviceURL, "provenance_getNoteRecognition", [
                { commitment: fixture.params.noteCommitments[0] },
            ]);
            return n.recognitionState === "recognized" ? n : null;
        });
        save("successor-recognition.json", child);
        assert.equal(child.note.noteCommitment, fixture.params.noteCommitments[0]);
        assert.equal(child.note.checkpointSequence, "2");
        const old = await rpc(serviceURL, "provenance_getNoteRecognition", [
            {
                commitment: shieldRequest.params.noteCommitments[0],
            },
        ]);
        assert.equal(old.recognitionState, "recognized", "spent input remains in recognized set");
        report.sourceRecognitionComplete = true;
        if (verifiedJobID) report.jobId = verifiedJobID;
        report.manifestSha256 = sourceBundle.manifestSha256;
        report.inputCertificate = cert;
        report.outputCertificate = child.certificate;
        report.protocolAddress = protocol.toLowerCase();
        report.privateTransaction = privateReceipt.transactionHash;
        report.outputCommitment = fixture.params.noteCommitments[0];
        const autoRoots = await rpc(serviceURL, "provenance_getRoots", [
            { after: "0", limit: "20" },
        ]);
        assert.equal(
            autoRoots.items.length,
            2,
            "tracked private settlement publishes exactly one successor checkpoint"
        );
        assert.equal(
            autoRoots.items.at(-1).leafCount,
            "2",
            "one successor Note appends exactly one recognition leaf"
        );
        report.credit = await creditScenario({
            runtime,
            root,
            directory,
            leaves: [sourceC, ...fixture.params.noteCommitments],
            serviceURL,
            rpc,
            until,
            save,
            step,
        });
        if (replicas)
            report.replicasBeforeReorg = await replicas.check("before-reorg", cert.chainGeneration);
        const liveConfig = JSON.parse(readFileSync(join(directory, "provenance/config.json"))),
            pub = liveConfig.signingPublicKey,
            keyID = "0x" + sha(Buffer.from(pub.slice(2), "hex"));
        save("sdk-trust.json", {
            format: "invisi-provenance-sdk-live-v1",
            endpoint: serviceURL.replace("/v1/chains/31337", ""),
            scope: {
                chainId: "31337",
                protocolAddress: protocol.toLowerCase(),
            },
            chainGeneration: cert.chainGeneration,
            providerId: liveConfig.providerId,
            initialSigningPublicKey: pub,
            initialSigningKeyId: keyID,
            currentSigningPublicKey: pub,
            currentSigningKeyId: keyID,
            manifestSha256: sourceBundle.manifestSha256,
            keyRotations: liveConfig.keyRotations ?? [],
            checkedAt: String(Math.floor(Date.now() / 1000)),
            rootId: `${child.certificate.chainGeneration}:${child.certificate.rootSequence}`,
            commitment: fixture.params.noteCommitments[0],
            ...(verifiedJobID ? { jobId: verifiedJobID } : {}),
            trackingId: trackingPreflight.tracking.id,
            ...(options.recovery
                ? {
                      recovery: await recoveryFixture({
                          runtime,
                          root,
                          directory,
                          privateReceipt,
                          data,
                          operationHash,
                          inputNullifiers: fixture.params.nullifiers,
                          sourceBundle,
                          invalidJob: invalidRecoveryJob,
                          trackingId: trackingPreflight.tracking.id,
                          save,
                      }),
                  }
                : {}),
        });
        if (process.env.INVISI_PROVENANCE_LIVE_HOOK || options.sdk) {
            step("public-read-window-before-sdk");
            await new Promise((r) => setTimeout(r, 61000));
            step("real-http-sdk-hook");
            const hook = process.env.INVISI_PROVENANCE_LIVE_HOOK
                ? start(
                      "/bin/sh",
                      ["-c", process.env.INVISI_PROVENANCE_LIVE_HOOK],
                      repoRoot,
                      "sdk-live"
                  )
                : start(
                      process.execPath,
                      [join(repoRoot, "invisi-sdk-ts/scripts/provenance-live-all.mjs")],
                      repoRoot,
                      "sdk-live"
                  );
            await new Promise((res, rej) =>
                hook.once("exit", (code) =>
                    code === 0 ? res() : rej(Error("SDK live hook failed " + code))
                )
            );
            children.splice(children.indexOf(hook), 1);
            report.sdkLive = JSON.parse(readFileSync(join(directory, "sdk-live-validation.json")));
        }

        if (options.recovery) {
            const wrapper = join(
                repoRoot,
                "invisi-sdk-ts/scripts/provenance-recovery-live-all.mjs"
            );
            if (process.env.INVISI_PROVENANCE_RECOVERY_HOOK || existsSync(wrapper)) {
                step("public-read-window-before-sdk-recovery");
                await new Promise((r) => setTimeout(r, 61000));
                step("real-http-sdk-recovery-hook");
                const hook = process.env.INVISI_PROVENANCE_RECOVERY_HOOK
                    ? start(
                          "/bin/sh",
                          ["-c", process.env.INVISI_PROVENANCE_RECOVERY_HOOK],
                          repoRoot,
                          "sdk-recovery-live"
                      )
                    : start(process.execPath, [wrapper], repoRoot, "sdk-recovery-live");
                await new Promise((res, rej) =>
                    hook.once("exit", (code) =>
                        code === 0 ? res() : rej(Error("SDK Recovery live hook failed " + code))
                    )
                );
                children.splice(children.indexOf(hook), 1);
                report.recoveryLive = JSON.parse(
                    readFileSync(join(directory, "sdk-recovery-live-validation.json"))
                );
            } else {
                assert(
                    options.keep,
                    "Recovery live wrapper is not ready; --keep retains fixture for explicit live hook"
                );
                step("recovery-public-fixture-ready-awaiting-sdk-wrapper");
            }
        }

        if (
            (options.browser || options.details) &&
            (options.sdk || options.recovery || process.env.INVISI_PROVENANCE_LIVE_HOOK)
        ) {
            step("public-read-window-before-browser");
            await new Promise((r) => setTimeout(r, 61000));
        }
        if (options.browser || options.details)
            report.browser = await browserScenario({
                root,
                serviceRoot,
                serviceURL,
                skipExisting: !!options.details,
                report,
                save,
                step,
            });
        if (options.reorg)
            report.reorg = await reorgScenario({
                runtime,
                directory,
                snapshot,
                replicas,
                serviceURL,
                rpc,
                until,
                sourceNote,
                sourceC,
                sourceBundle,
                cert,
                shieldReceipt,
                data,
                operationHash,
                save,
                step,
            });
    }
    if (replicas && options.reorg)
        report.replicasAfterReorg = await replicas.check(
            "after-reorg",
            BigInt(cert.chainGeneration) + 1n
        );
    report.chainSettlementComplete = true;
    report.shieldTransaction = shieldReceipt.transactionHash;
    report.privateTransaction = privateReceipt.transactionHash;
    report.inputCommitment = shieldRequest.params.noteCommitments[0];
    report.outputCommitment = fixture.params.noteCommitments[0];
    report.poolBalance = String(amount);
    report.completedAt = new Date().toISOString();
    successful = true;
    step(
        options["chain-only"]
            ? "complete-real-chain-settlement-only"
            : "complete-real-chain-provenance-flow",
        { sourceRecognitionComplete: !!report.sourceRecognitionComplete }
    );
} catch (error) {
    report.error = { stage, message: error.message };
    report.failedAt = new Date().toISOString();
    save("report.json", report);
    console.error(error.stack);
    process.exitCode = 1;
} finally {
    if (options.keep && runtime) {
        console.log(
            "Owned local processes retained; inspect " + directory + " and send SIGINT to stop."
        );
        await new Promise((resolve) => {
            process.once("SIGINT", resolve);
            process.once("SIGTERM", resolve);
        });
    }
    for (const child of children.reverse()) await stop(child);
    await runtime?.stop();
    await replicas?.cleanup();
    save("report.json", report);
    console.log((successful ? "PASS " : "FAIL ") + directory);
}
