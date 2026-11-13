/**
 * Local relay acceptance: node test-support/integration/provenance-broadcaster-e2e.mjs [--output=DIR]
 * Add --highlevel=typescript --schedule=both for real-proof scheduled cancellation and publication.
 * Runs real Protocol/RPC/Provenance/BB/Broadcaster services on owned Anvil with host time.
 * Local ERC20, public wallets and explicit StaticPrices ratios are test assets.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHTTPSServer } from "node:https";
import { createPublicKey } from "node:crypto";
import { AbiCoder, Wallet, ZeroAddress, ZeroHash, keccak256, verifyTypedData } from "ethers";
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
import {
    proveWitness,
    trustedManifest,
} from "../../../invisi-protocol/scripts/provenance-proof.mjs";
import {
    assertTracking,
    preflightTracking,
    trackedRecognition,
} from "./provenance-e2e-tracking.mjs";

const options = {};
for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(output|service-port|rpc-port|highlevel|schedule)=(.+)$/);
    assert(m, "unknown option " + arg);
    assert(!Object.hasOwn(options, m[1]), "duplicate option");
    options[m[1]] = m[2];
    if (m[1] === "highlevel") assert(m[2] === "typescript", "unsupported highlevel runner");
    if (m[1] === "schedule")
        assert(["both", "aggregate"].includes(m[2]), "unsupported schedule scenario");
}
assert(
    !options.schedule || options.highlevel === "typescript",
    "schedule requires --highlevel=typescript"
);
const directory = resolve(
        options.output ?? join(root, ".tools/provenance-broadcaster-e2e/runs", String(Date.now()))
    ),
    repoRoot = resolve(root, ".."),
    rpcRoot = join(repoRoot, "invisi-protocol-rpc"),
    serviceRoot = join(repoRoot, "invisi-provenance"),
    broadcasterRoot = join(repoRoot, "invisi-protocol-broadcaster"),
    bin = join(directory, "bin");
mkdirSync(bin, { recursive: true });
const save = (name, value) => writeFileSync(join(directory, name), json(value), { mode: 0o600 });
const children = [];
let runtime;
let finalityMining;
let miningBlock = false;
let tlsProxy;
let successful = false;
let stage = "build";
const report = {
    format: "invisi.provenance.broadcaster-e2e.v1",
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
function start(command, args, cwd, label, extraEnv = {}) {
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
                ...extraEnv,
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
    if (options.highlevel) {
        step("build-current-typescript-sdk");
        run("pnpm", ["build"], join(repoRoot, "invisi-sdk-ts"));
    }
    {
        step("build-real-services");
        run("go", ["build", "-mod=readonly", "-o", join(bin, "protocol-rpc"), "./cmd"], rpcRoot);
        run(
            "go",
            ["build", "-mod=readonly", "-o", join(bin, "provenance"), "./cmd/provenance"],
            serviceRoot
        );
        run(
            "go",
            ["build", "-mod=readonly", "-o", join(bin, "broadcaster"), "./cmd"],
            broadcasterRoot
        );
        report.serviceBinaries = {
            broadcasterSha256: fingerprint(join(bin, "broadcaster")),
            protocolRPCSha256: fingerprint(join(bin, "protocol-rpc")),
            provenanceSha256: fingerprint(join(bin, "provenance")),
        };
    }
    step("build-current-protocol-artifacts");
    run("forge", ["build", "--deny", "warnings", "--no-lint"], root);
    step("deploy-complete-real-main-release");
    runtime = await createSettlementRuntime({
        root,
        directory: join(directory, "chain"),
        timestamp: "wall-clock",
    });
    const { context, tokens, sender, protocol, proto, token, tx, call } = runtime;
    const hostUnix = Math.floor(Date.now() / 1000);
    assert(
        Math.abs(Number(context.timestamp) - hostUnix) <= 5,
        "owned chain settlement clock must match host"
    );
    report.clock = {
        mode: "wall-clock",
        hostUnix: String(hostUnix),
        settlementBlockUnix: context.timestamp.toString(),
    };
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
    const amount = options.highlevel ? 1000000000000000000n : 100000000000000000n,
        wallet = await fixtureWallet(1),
        sourceNote = {
            ownerAddress: wallet.ownerAddress,
            amount,
            nonce: 424242n,
            treeId: 1n,
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
            deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
            funding: funding(amount),
        }),
        shieldData = proto.encodeFunctionData("shield", [
            shieldRequest.params,
            shieldRequest.outputs,
            shieldRequest.deliveries,
            shieldRequest.funding,
        ]);
    // Preserve the revert reason before sending a fixture transaction or starting dependent services.
    try {
        await runtime.rpc("eth_call", [{ from: sender, to: protocol, data: shieldData }, "latest"]);
    } catch (error) {
        save(
            "shield.trace.json",
            await runtime.rpc("debug_traceCall", [
                { from: sender, to: protocol, data: shieldData },
                "latest",
                { tracer: "callTracer" },
            ])
        );
        throw error;
    }
    const shieldReceipt = await tx("shield", protocol, shieldData),
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
    // Anvil native finalized trails its head; advance real empty blocks without replacing tags.
    finalityMining = setInterval(async () => {
        if (miningBlock) return;
        miningBlock = true;
        try {
            await runtime.rpc("anvil_mine", ["0x4", "0x0"]);
        } catch {
            // Service and chain readiness checks surface owned-node failures.
        } finally {
            miningBlock = false;
        }
    }, 250);
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
    let sourceBundle, cert, serviceURL;
    sourceFlow: {
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
                finality: "finalized",
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

        serviceProcess = start(
            join(bin, "provenance"),
            ["-dir", serviceDir, "run"],
            serviceRoot,
            "provenance"
        );
        serviceURL = `http://127.0.0.1:${servicePort}/v1/chains/31337`;
        save("services.json", {
            protocolRPC,
            provenanceRPC: serviceURL,
            explorer: `http://127.0.0.1:${servicePort}/api/v1`,
            protocolRPCPid: rpcProcess.pid,
            provenancePid: serviceProcess.pid,
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

        step("start-real-broadcaster-with-explicit-local-price-policy");
        const relay = Wallet.createRandom(),
            bcPort = await port(),
            bcDir = join(directory, "broadcaster");
        await runtime.rpc("anvil_setBalance", [relay.address, "0x8ac7230489e80000"]);
        run(join(bin, "broadcaster"), ["init", bcDir], broadcasterRoot);
        const keyFile = join(bcDir, "sender.key");
        writeFileSync(keyFile, relay.privateKey.slice(2) + "\n", { mode: 0o600 });
        const keyID = "0x" + sha(Buffer.from(cfg.signingPublicKey.slice(2), "hex"));
        const bcConfig = {
            listen: `127.0.0.1:${bcPort}`,
            maxConcurrentRequests: 16,
            chains: [
                {
                    chainRpc: rpcConfig.chains[0].chainRpc,
                    deployment: rpcConfig.chains[0].deployment,
                    database: {
                        driver: "sqlite",
                        path: join(bcDir, "broadcaster.sqlite"),
                    },
                    feeRecipient: relay.address,
                    privateKeyFile: keyFile,
                    maxGas: 30000000,
                    maxFeePerGas: "1000000000",
                    maxPriorityFeePerGas: "1000000",
                    gasMarginBps: 2000,
                    markupBps: 3000,
                    prices: {
                        [tokens[0].toLowerCase()]: {
                            numerator: "1",
                            denominator: "1",
                            validUntil: new Date(Date.now() + 3600000).toISOString(),
                        },
                    },
                    ...(options.highlevel
                        ? {
                              aggregation: {
                                  enabled: options.schedule !== "both",
                                  bbPath: join(root, ".tools/bb/bb"),
                                  noirExecutePath: join(root, ".tools/noir/noir-execute"),
                                  threads: 4,
                                  maxWaitSeconds: 5,
                                  proofTimeoutSeconds: 60,
                                  activityWindowSeconds: 300,
                                  minRecentActivity: 1,
                                  pollIntervalMillis: 100,
                                  minDeadlineSlackSeconds: 5,
                                  maxBatchGas: 30000000,
                              },
                          }
                        : {}),
                    provenance: {
                        enabled: true,
                        endpoint: serviceURL,
                        providerId: cfg.providerId,
                        providerKeys: { [keyID]: cfg.signingPublicKey },
                        manifestSha256: [manifest.manifestSha256],
                        timeoutMillis: 30000,
                        maxResponseBytes: 1048576,
                    },
                },
            ],
        };
        writeFileSync(join(bcDir, "config.json"), json(bcConfig), { mode: 0o600 });
        let bcProcess = start(
            join(bin, "broadcaster"),
            ["run", "--dir", bcDir],
            broadcasterRoot,
            "broadcaster"
        );
        const bcURL = `http://127.0.0.1:${bcPort}/v1/chains/31337`;
        const bcStatus = await until("broadcaster source verification active", async () => {
            const s = await rpc(bcURL, "broadcaster_getStatus");
            return s.provenance.enabled ? s : null;
        });
        assert.equal(bcStatus.provenance.trackingSupported, true);
        assert.equal(bcStatus.provenance.trackingRequired, true);
        if (options.highlevel) {
            step("normal-sdk-highlevel-flow-with-local-wallet-host");
            await runtime.rpc("evm_mine", []);
            const tlsDir = join(directory, "tls");
            mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
            const certPath = join(tlsDir, "owned-loopback-ca.pem"),
                keyPath = join(tlsDir, "owned-loopback.key"),
                tlsConfig = join(tlsDir, "openssl.cnf");
            writeFileSync(
                tlsConfig,
                "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=Owned Invisi E2E loopback\n[v3]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\nextendedKeyUsage=serverAuth\n",
                { mode: 0o600 }
            );
            run(
                "openssl",
                [
                    "req",
                    "-x509",
                    "-newkey",
                    "rsa:2048",
                    "-nodes",
                    "-sha256",
                    "-days",
                    "1",
                    "-config",
                    tlsConfig,
                    "-keyout",
                    keyPath,
                    "-out",
                    certPath,
                ],
                root
            );
            const tlsPort = await port();
            tlsProxy = createHTTPSServer(
                { key: readFileSync(keyPath), cert: readFileSync(certPath) },
                async (request, response) => {
                    try {
                        assert.equal(request.url, "/v1/chains/31337");
                        assert.equal(request.method, "POST");
                        const chunks = [];
                        let size = 0;
                        for await (const chunk of request) {
                            size += chunk.length;
                            assert(size <= 2 << 20, "owned proxy request exceeds limit");
                            chunks.push(chunk);
                        }
                        const result = await fetch(bcURL, {
                            method: "POST",
                            headers: { "content-type": "application/json" },
                            body: Buffer.concat(chunks),
                            signal: AbortSignal.timeout(60000),
                        });
                        response.writeHead(result.status, {
                            "content-type": "application/json",
                        });
                        response.end(Buffer.from(await result.arrayBuffer()));
                    } catch {
                        response.writeHead(502, { "content-type": "application/json" });
                        response.end(JSON.stringify({ error: "Owned loopback proxy unavailable" }));
                    }
                }
            );
            await new Promise((resolve, reject) => {
                tlsProxy.once("error", reject);
                tlsProxy.listen(tlsPort, "127.0.0.1", resolve);
            });
            const fixturePath = join(directory, "highlevel-public-fixture.json");
            save("highlevel-public-fixture.json", {
                format: "invisi.provenance.highlevel-owned-v1",
                output: directory,
                chainRPC: rpcConfig.chains[0].chainRpc,
                protocolRPC,
                sourceEndpoint: serviceURL.replace("/v1/chains/31337", ""),
                scope: {
                    chainId: "31337",
                    protocolAddress: protocol.toLowerCase(),
                },
                generation: cert.chainGeneration,
                providerId: cfg.providerId,
                signingKeyId: keyID,
                signingPublicKey: cfg.signingPublicKey,
                manifestSha256: manifest.manifestSha256,
                sourceAssetRoot: join(repoRoot, "invisi-sdk-ts/packages/prover/provenance"),
                crsPath,
                bbPath: join(root, ".tools/bb/bb"),
                broadcaster: {
                    endpoint: `https://127.0.0.1:${tlsPort}/v1/chains/31337`,
                    quoteSigner: relay.address,
                    feeRecipient: relay.address,
                    provenanceRequired: true,
                },
                broadcasterCAFile: certPath,
                tokenAddress: tokens[0].toLowerCase(),
                sourceCommitment: shieldRequest.params.noteCommitments[0],
                maxFeeAmount: (amount / 2n).toString(),
                recipientAmount: (amount / 100n).toString(),
                selfOutputAmount: (amount / 4n).toString(),
                ...(options.schedule
                    ? {
                          scheduleMode: "publish",
                          scheduleDelaySeconds: 180,
                          ...(options.schedule === "aggregate" ? { execution: "aggregate" } : {}),
                      }
                    : {}),
            });
            const sdkRoot = join(repoRoot, "invisi-sdk-ts");
            if (options.schedule === "both") {
                step("real-sdk-scheduled-cancellation");
                const cancelOutput = join(directory, "schedule-cancel");
                mkdirSync(cancelOutput, { recursive: true, mode: 0o700 });
                const cancelFixture = join(cancelOutput, "fixture.json");
                writeFileSync(
                    cancelFixture,
                    json({
                        ...JSON.parse(readFileSync(fixturePath)),
                        output: cancelOutput,
                        scheduleMode: "cancel",
                        recipientAmount: (amount / 100n + 1n).toString(),
                    }),
                    { mode: 0o600 }
                );
                const cancelChild = start(
                    join(sdkRoot, "examples/node_modules/.bin/tsx"),
                    [
                        fileURLToPath(
                            new URL("./provenance-highlevel-typescript.ts", import.meta.url)
                        ),
                        "--execute",
                        "--submit",
                    ],
                    sdkRoot,
                    "highlevel-typescript-schedule-cancel",
                    { INVISI_HIGHLEVEL_FIXTURE: cancelFixture, NODE_EXTRA_CA_CERTS: certPath }
                );
                await new Promise((resolve, reject) =>
                    cancelChild.once("exit", (code) =>
                        code === 0
                            ? resolve()
                            : reject(Error("scheduled cancellation failed " + code))
                    )
                );
                children.splice(children.indexOf(cancelChild), 1);
                report.scheduledCancellation = JSON.parse(
                    readFileSync(join(cancelOutput, "highlevel-typescript.json"))
                );
                assert.equal(report.scheduledCancellation.cancelledBeforePublication, true);
                step("real-sdk-scheduled-publication");
            }
            const child = start(
                join(sdkRoot, "examples/node_modules/.bin/tsx"),
                [
                    fileURLToPath(new URL("./provenance-highlevel-typescript.ts", import.meta.url)),
                    "--execute",
                    "--submit",
                ],
                sdkRoot,
                "highlevel-typescript",
                {
                    INVISI_HIGHLEVEL_FIXTURE: fixturePath,
                    NODE_EXTRA_CA_CERTS: certPath,
                }
            );
            await new Promise((resolve, reject) =>
                child.once("exit", (code) =>
                    code === 0
                        ? resolve()
                        : reject(Error("normal TypeScript SDK flow failed " + code))
                )
            );
            children.splice(children.indexOf(child), 1);
            const result = JSON.parse(readFileSync(join(directory, "highlevel-typescript.json")));
            assert.equal(result.complete, true);
            assert.equal(result.manualSidecarsAtCaller, false);
            report.highlevel = result;
            if (options.schedule === "both") {
                assert.equal(result.scheduling, "publish");
                const cancelled = await rpc(bcURL, "broadcaster_getTransactionStatus", [
                    { id: report.scheduledCancellation.id },
                ]);
                assert.equal(
                    cancelled.state,
                    "cancelled",
                    "cancelled request must remain cancelled beyond its publication boundary"
                );
                assert.equal(cancelled.transactionHash, undefined);
                report.scheduledCancellation.remainedCancelledAfterPublicationBoundary = true;
            }
            assert.equal(
                result.execution,
                options.schedule === "aggregate" ? "aggregate" : "direct",
                "signed execution must match the selected scenario"
            );
            assert.equal(
                result.changeCommitments.length,
                1,
                "first payment must retain recognized change"
            );
            assert.equal(
                bcStatus.provenance.aggregateSupported,
                options.schedule !== "both",
                "native aggregation must match the selected scenario"
            );
            if (!options.schedule) {
                step("normal-sdk-async-aggregate-single-fallback");
                const aggregateOutput = join(directory, "aggregate-highlevel");
                mkdirSync(aggregateOutput, { recursive: true, mode: 0o700 });
                const aggregateFixturePath = join(aggregateOutput, "fixture.json");
                writeFileSync(
                    aggregateFixturePath,
                    json({
                        ...JSON.parse(readFileSync(fixturePath)),
                        output: aggregateOutput,
                        sourceCommitment: result.changeCommitments[0],
                        knownOtherRecipientCommitments: result.recipientCommitments,
                        execution: "aggregate",
                        selfOutputAmount: undefined,
                        expectedSourceCheckpoint: "3",
                    }),
                    { mode: 0o600 }
                );
                const aggregateChild = start(
                    join(sdkRoot, "examples/node_modules/.bin/tsx"),
                    [
                        fileURLToPath(
                            new URL("./provenance-highlevel-typescript.ts", import.meta.url)
                        ),
                        "--execute",
                        "--submit",
                    ],
                    sdkRoot,
                    "highlevel-typescript-aggregate",
                    {
                        INVISI_HIGHLEVEL_FIXTURE: aggregateFixturePath,
                        NODE_EXTRA_CA_CERTS: certPath,
                    }
                );
                await new Promise((resolve, reject) =>
                    aggregateChild.once("exit", (code) =>
                        code === 0
                            ? resolve()
                            : reject(Error("normal TypeScript aggregate flow failed " + code))
                    )
                );
                children.splice(children.indexOf(aggregateChild), 1);
                const aggregateResult = JSON.parse(
                    readFileSync(join(aggregateOutput, "highlevel-typescript.json"))
                );
                assert.equal(aggregateResult.complete, true);
                assert.equal(aggregateResult.execution, "aggregate");
                assert.equal(aggregateResult.manualSidecarsAtCaller, false);
                report.highlevelAggregate = aggregateResult;
                step("normal-sdk-two-member-native-aggregate");
                const batchRoot = join(directory, "aggregate-two-member");
                mkdirSync(batchRoot, { recursive: true, mode: 0o700 });
                const sourceCommitments = [
                    aggregateResult.changeCommitments[0],
                    result.ownedOutputCommitments[0],
                ];
                assert(sourceCommitments.every(Boolean));
                const members = ["alice-a", "alice-b"];
                const batchChildren = members.map((member, index) => {
                    const output = join(batchRoot, member);
                    mkdirSync(output, { recursive: true, mode: 0o700 });
                    const fixture = join(output, "fixture.json");
                    writeFileSync(
                        fixture,
                        json({
                            ...JSON.parse(readFileSync(fixturePath)),
                            output,
                            selfOutputAmount: undefined,
                            sourceCommitment: sourceCommitments[index],
                            knownOtherRecipientCommitments: [
                                ...result.recipientCommitments,
                                ...aggregateResult.recipientCommitments,
                            ],
                            execution: "aggregate",
                            expectedBatchSize: 2,
                            minimumSourceCheckpoint: "4",
                            submitBarrier: { directory: batchRoot, member, members },
                        }),
                        { mode: 0o600 }
                    );
                    return start(
                        join(sdkRoot, "examples/node_modules/.bin/tsx"),
                        [
                            fileURLToPath(
                                new URL("./provenance-highlevel-typescript.ts", import.meta.url)
                            ),
                            "--execute",
                            "--submit",
                        ],
                        sdkRoot,
                        `highlevel-batch-${member}`,
                        { INVISI_HIGHLEVEL_FIXTURE: fixture, NODE_EXTRA_CA_CERTS: certPath }
                    );
                });
                await Promise.all(
                    batchChildren.map(
                        (child) =>
                            new Promise((resolve, reject) =>
                                child.once("exit", (code) =>
                                    code === 0
                                        ? resolve()
                                        : reject(Error("two-member SDK flow failed " + code))
                                )
                            )
                    )
                );
                batchChildren.forEach((child) => children.splice(children.indexOf(child), 1));
                const batchResults = members.map((member) =>
                    JSON.parse(readFileSync(join(batchRoot, member, "highlevel-typescript.json")))
                );
                assert(
                    batchResults.every(
                        (member) =>
                            member.complete &&
                            member.execution === "aggregate" &&
                            member.manualSidecarsAtCaller === false
                    )
                );
                assert.equal(
                    batchResults[0].transactionHash,
                    batchResults[1].transactionHash,
                    "both independently proven members share exactly one real outer transaction"
                );
                assert.deepEqual(batchResults.map((member) => member.operationIndex).sort(), [
                    "0",
                    "1",
                ]);
                report.highlevelAggregateBatch = batchResults;
            }
            Object.assign(report, {
                realBroadcaster: true,
                realNativeProvenanceVerifier: true,
                sourceRecognitionComplete: true,
                highlevelSDK: "typescript",
                realAsyncAggregation: bcStatus.provenance.aggregateSupported === true,
                completedAt: new Date().toISOString(),
            });
            break sourceFlow;
        }
        const direct = proto.fragments.find(
            (f) =>
                f.type === "function" && f.name === "transact" && f.inputs[1].baseType === "tuple"
        );
        const estimateFixture = await createTransactSlotsFixture(1, 0, {
            context,
            wallet,
            sourceNotes: [sourceNote],
            sourceTrees: [{ treeId: 1n, depositCommitments: [sourceC] }],
            outputNotes: [],
            outputWallets: [],
            funding: funding(0n),
            feeAmount: 1n,
            feeRecipient: relay.address,
            withdrawalAddress: sender,
            withdrawalAmount: amount - 1n,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        });
        const estimateData = proto.encodeFunctionData(direct, [
            "0x",
            settlementDirectRequest(estimateFixture),
        ]);
        const fee = await rpc(bcURL, "broadcaster_estimateQuote", [{ data: estimateData }]),
            feeAmount = BigInt(fee.feeAmount);
        assert(
            feeAmount > 0n && feeAmount <= amount / 2n,
            "formal cap quote exceeds explicit test budget"
        );
        assert.equal(fee.feeRecipient.toLowerCase(), relay.address.toLowerCase());
        save("broadcaster-policy.json", {
            sender: relay.address,
            feeRecipient: relay.address,
            priceUnits:
                "test token base units per native wei; both assets18decimals; operator local fixture1testtoken/AnvilETH",
            numerator: "1",
            denominator: "1",
            gasMarginBps: "2000",
            markupBps: "3000",
            maxFeePerGas: "1000000000",
            maxGas: "30000000",
            budget: (amount / 2n).toString(),
            fee,
            provenance: bcConfig.chains[0].provenance,
        });
        step("prove-real-main-c1-fee-bearing-withdrawal");
        const fixture = await createTransactSlotsFixture(1, 0, {
                context,
                wallet,
                sourceNotes: [sourceNote],
                sourceTrees: [{ treeId: 1n, depositCommitments: [sourceC] }],
                outputNotes: [],
                feeAmount,
                feeRecipient: relay.address,
                withdrawalAddress: sender,
                withdrawalAmount: amount - feeAmount,
                outputWallets: [],
                funding: funding(0n),
                deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
            }),
            mainBundle = await proveUserNative(fixture, {
                root,
                directory: join(directory, "main-proof"),
                mode: "direct",
                threads: 4,
            }),
            request = settlementDirectRequest(fixture),
            data = proto.encodeFunctionData(direct, [mainBundle.proofHex, request]);
        assert.equal(mainBundle.profile.capacity, 1);
        const operationHash = operationDigest({
            chainId: context.chainId,
            protocolAddress: protocol,
            operationKind: 2,
            mainCircuitCapacity: 1,
            publicInputs: mainBundle.publicInputs,
        });
        save("private-calldata.json", {
            data,
            operationDigest: operationHash,
            mainCapacity: 1,
            publicInputs: mainBundle.publicInputs,
            deadline: fixture.params.deadline,
            noteNullifiers: fixture.params.nullifiers,
            noteOutputs: fixture.params.noteCommitments,
        });
        save("synthetic-wallet-fixture.json", {
            nonsecretPublicTestSeeds: true,
            sourceNote,
            outputNotes: [],
            context,
        });
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
        step("quote-without-source-proof-and-reject-sidecars-at-quote");
        const sidecars = [{ operationIndex: "0", proofBundle: sourceBundle }],
            negative = [];
        async function denied(label, method, query, expected = /-32010|-32602/) {
            try {
                await rpc(bcURL, method, [query]);
                assert.fail(label + " was accepted");
            } catch (error) {
                assert(!error.message.includes("was accepted"), error.message);
                assert(
                    expected.test(error.message),
                    label + " unexpected rejection " + error.message
                );
                negative.push({ label, message: error.message });
            }
        }
        const initialNonce = await runtime.rpc("eth_getTransactionCount", [
            relay.address,
            "latest",
        ]);
        const shapedFee = await rpc(bcURL, "broadcaster_estimateQuote", [{ data }]);
        assert(BigInt(shapedFee.feeAmount) <= feeAmount, "cap fee must cover final shape");
        const quoteWithoutProof = await rpc(bcURL, "broadcaster_getQuote", [{ data }]);
        assert.equal(quoteWithoutProof.provenanceRequired, true);
        await denied("quote-unexpected-sidecar", "broadcaster_getQuote", {
            data,
            proofSidecars: sidecars,
        });
        const wrongBundle = structuredClone(sourceBundle);
        wrongBundle.publicInputs[7] = "0x" + "00".repeat(32);
        await denied("quote-wrong-digest", "broadcaster_getQuote", {
            data,
            proofSidecars: [{ operationIndex: "0", proofBundle: wrongBundle }],
        });
        const trackingRows = () =>
            Number(
                run(
                    "sqlite3",
                    [
                        "-readonly",
                        join(serviceDir, "provenance.sqlite"),
                        "SELECT count(*) FROM confirmation_tracking",
                    ],
                    serviceRoot
                ).stdout.trim()
            );
        const sourceSnapshot = () =>
            JSON.parse(
                run(
                    "sqlite3",
                    [
                        "-readonly",
                        join(serviceDir, "provenance.sqlite"),
                        "SELECT json_object('operations',(SELECT count(*) FROM operations),'recognizedNotes',(SELECT count(*) FROM recognized_notes),'checkpoints',(SELECT count(*) FROM checkpoints),'published',(SELECT count(*) FROM checkpoints WHERE published=1))",
                    ],
                    serviceRoot
                ).stdout.trim()
            );
        const beforeCandidate = sourceSnapshot();
        assert(
            beforeCandidate.operations >= 1,
            "canonical Shield and any deployment diagnostics indexed"
        );
        assert.deepEqual(
            { ...beforeCandidate, operations: 0 },
            { operations: 0, recognizedNotes: 1, checkpoints: 1, published: 1 }
        );
        const trackingBeforeInvalid = trackingRows();
        assert.equal(trackingBeforeInvalid, 0, "public Shield needs no confirmation task");
        step("reject-real-invalid-preflight-without-tracking");
        const invalidBundle = structuredClone(sourceBundle);
        invalidBundle.proof =
            invalidBundle.proof.slice(0, -2) +
            (Number.parseInt(invalidBundle.proof.slice(-2), 16) ^ 1).toString(16).padStart(2, "0");
        const invalidPreflight = await rpc(serviceURL, "provenance_evaluateTransaction", [
            {
                data,
                proofSidecars: [{ operationIndex: "0", proofBundle: invalidBundle }],
            },
        ]);
        assert.notEqual(invalidPreflight.broadcastDecision, "allow");
        assert.equal(invalidPreflight.inputProofStatus, "invalid");
        assert(
            !invalidPreflight.tracking,
            "invalid native proof must not create a tracking capability"
        );
        assert.equal(
            trackingRows(),
            trackingBeforeInvalid,
            "invalid native proof leaves no candidate task behind"
        );
        const invalidJobs = Number(
            run(
                "sqlite3",
                [
                    "-readonly",
                    join(serviceDir, "provenance.sqlite"),
                    "SELECT count(*) FROM proof_jobs WHERE status='invalid'",
                ],
                serviceRoot
            ).stdout.trim()
        );
        assert.equal(
            invalidJobs,
            1,
            "actual configured native verifier rejected the malformed proof"
        );
        save("invalid-preflight-no-tracking.json", {
            decision: invalidPreflight,
            taskRowsBefore: trackingBeforeInvalid,
            taskRowsAfter: trackingRows(),
            actualInvalidVerifierJobs: invalidJobs,
        });
        const preflight = await preflightTracking({
            rpc,
            serviceURL,
            data,
            sourceBundle,
            operationHash,
        });
        assertTracking(preflight.tracking, operationHash, "pending_confirmation");
        assert.equal(trackingRows(), 1);
        save("tracking-before-restart.json", preflight);
        step("restart-source-after-durable-preflight-before-broadcast");
        await stop(serviceProcess);
        children.splice(children.indexOf(serviceProcess), 1);
        await denied(
            "submit-source-offline",
            "broadcaster_submitTransaction",
            {
                data,
                quote: quoteWithoutProof.quote,
                signature: quoteWithoutProof.signature,
                proofSidecars: sidecars,
            },
            /-32011/
        );
        assert.equal(
            await runtime.rpc("eth_getTransactionCount", [relay.address, "latest"]),
            initialNonce,
            "Source outage must reject before sending"
        );
        serviceProcess = start(
            join(bin, "provenance"),
            ["-dir", serviceDir, "run"],
            serviceRoot,
            "provenance-restarted-before-broadcast"
        );
        await until("restarted native worker healthy", async () => {
            const status = await rpc(serviceURL, "provenance_getStatus");
            return status.workerAvailable ? status : null;
        });
        const persisted = await rpc(serviceURL, "provenance_getTracking", [
            { trackingId: preflight.tracking.id },
        ]);
        assertTracking(persisted.tracking, operationHash, "pending_confirmation");
        const repeated = await preflightTracking({
            rpc,
            serviceURL,
            data,
            sourceBundle,
            operationHash,
        });
        assert.equal(
            repeated.tracking.id,
            preflight.tracking.id,
            "restart and duplicate preflight reuse one task"
        );
        assert.equal(
            trackingRows(),
            1,
            "persistent task remains unique after source restart and deduplicated preflight"
        );
        assert.deepEqual(
            sourceSnapshot(),
            beforeCandidate,
            "unbroadcast preflight must not create Explorer operations or recognition leaves/checkpoints"
        );
        save("tracking-after-restart.json", persisted);
        const verifiedPreflight = JSON.parse(
            run(
                "sqlite3",
                [
                    "-readonly",
                    join(serviceDir, "provenance.sqlite"),
                    "SELECT json_object('jobId',j.id,'operationId',j.operation_id,'status',j.status,'payload',json(j.payload)) FROM confirmation_tracking t JOIN proof_jobs j ON j.id=t.verified_job_id",
                ],
                serviceRoot
            ).stdout.trim()
        );
        assert.equal(verifiedPreflight.status, "valid");
        assert(verifiedPreflight.operationId.startsWith("preflight/"));
        assert.deepEqual(verifiedPreflight.payload.bundle, sourceBundle);
        save("tracking-native-preflight-verified.json", {
            jobId: verifiedPreflight.jobId,
            status: verifiedPreflight.status,
            operationId: verifiedPreflight.operationId,
            bundleSha256: sha(JSON.stringify(verifiedPreflight.payload.bundle)),
        });
        step("quote-real-source-k10-proof-bound-intent");
        const signed = await rpc(bcURL, "broadcaster_getQuote", [{ data }]);
        assert.equal(signed.provenanceRequired, true);
        assert.equal(signed.requestHashFormat, "invisi-broadcaster-provenance-intent-v1");
        assert.equal(signed.quote.feeAmount, feeAmount.toString());
        const abi = AbiCoder.defaultAbiCoder();
        const canonical = proto.encodeFunctionData(direct, ["0x", request]);
        const originalHash = keccak256(
            abi.encode(
                ["string", "string", "bytes"],
                ["InvisiBroadcasterIntentV1", "transact", canonical]
            )
        );
        const provenanceHash = keccak256(
            abi.encode(["string", "bytes32"], ["InvisiBroadcasterProvenanceIntentV1", originalHash])
        );
        assert.equal(
            signed.quote.requestHash,
            provenanceHash,
            "quote binds exact final intent and required source proof"
        );
        const recovered = verifyTypedData(
            {
                name: "InvisiBroadcaster",
                version: "1",
                chainId: 31337,
                verifyingContract: protocol,
            },
            {
                Quote: [
                    { name: "token", type: "address" },
                    { name: "feeRecipient", type: "address" },
                    { name: "feeAmount", type: "uint256" },
                    { name: "deadline", type: "uint256" },
                    { name: "maxGas", type: "uint256" },
                    { name: "requestHash", type: "bytes32" },
                    { name: "execution", type: "string" },
                ],
            },
            signed.quote,
            signed.signature
        );
        assert.equal(
            recovered.toLowerCase(),
            relay.address.toLowerCase(),
            "signed quote authenticates explicit relay operator"
        );
        save("quote-authentication.json", {
            originalHash,
            provenanceHash,
            recoveredSigner: recovered,
            deadline: signed.quote.deadline,
            hostUnix: String(Math.floor(Date.now() / 1000)),
        });
        save("broadcaster-signed-quote.json", signed);
        const submission = {
            data,
            quote: signed.quote,
            signature: signed.signature,
        };
        await denied("submit-missing-sidecar", "broadcaster_submitTransaction", submission);
        await denied("submit-wrong-digest", "broadcaster_submitTransaction", {
            ...submission,
            proofSidecars: [{ operationIndex: "0", proofBundle: wrongBundle }],
        });
        await denied("submit-real-invalid-proof", "broadcaster_submitTransaction", {
            ...submission,
            proofSidecars: [{ operationIndex: "0", proofBundle: invalidBundle }],
        });
        assert.equal(
            await runtime.rpc("eth_getTransactionCount", [relay.address, "latest"]),
            initialNonce,
            "negative checks must not consume sender nonce"
        );
        save("sidecar-negative-controls.json", negative);
        step("relay-exact-calldata-on-real-primary-chain");
        const accepted = await rpc(bcURL, "broadcaster_submitTransaction", [
            { ...submission, proofSidecars: sidecars },
        ]);
        assert.equal(typeof accepted.id, "string");
        assert(accepted.id.length > 0);
        const confirmed = await until("real Broadcaster receipt confirmed", async () => {
            const s = await rpc(bcURL, "broadcaster_getTransactionStatus", [{ id: accepted.id }]);
            assert(s.state !== "reverted" && s.state !== "uncertain", JSON.stringify(s));
            return s.state === "confirmed" ? s : null;
        });
        const privateReceipt = await runtime.rpc("eth_getTransactionReceipt", [
                confirmed.transactionHash,
            ]),
            relayed = await runtime.rpc("eth_getTransactionByHash", [confirmed.transactionHash]);
        assert.equal(privateReceipt.status, "0x1");
        assert.equal(relayed.from.toLowerCase(), relay.address.toLowerCase());
        assert.equal(relayed.input.toLowerCase(), data.toLowerCase());
        assert.equal(
            BigInt(await runtime.rpc("eth_getTransactionCount", [relay.address, "latest"])),
            BigInt(initialNonce) + 1n
        );
        assert.equal(
            await call(proto, protocol, "isNullifierSpent", [fixture.params.nullifiers[0]]),
            true
        );
        assert.equal(
            BigInt(await call(proto, protocol, "getNoteTreeNextLeafIndex", [1])),
            1n,
            "m0 withdrawal creates no ordinary Note leaf"
        );
        assert.equal(
            BigInt(
                await call(proto, protocol, "broadcasterFeeBalance", [tokens[0], relay.address])
            ),
            feeAmount
        );
        assert.equal(BigInt(await call(token, tokens[0], "balanceOf", [protocol])), feeAmount);
        assert.equal(
            BigInt(await call(token, tokens[0], "balanceOf", [sender])),
            amount * 10n - feeAmount
        );
        save("relayed-chain-facts.json", {
            transaction: relayed,
            receipt: privateReceipt,
            feeAmount,
            withdrawalAmount: amount - feeAmount,
            senderNonceBefore: initialNonce,
            senderNonceAfter: await runtime.rpc("eth_getTransactionCount", [
                relay.address,
                "latest",
            ]),
            ordinaryLeafCount: "1",
        });
        step("recognize-real-source-k10-withdrawal-without-new-leaf");
        const operationQuery = {
            blockHash: privateReceipt.blockHash,
            txHash: privateReceipt.transactionHash,
            operationIndex: "0",
        };
        const tracked = await trackedRecognition({
            rpc,
            until,
            serviceURL,
            tracking: preflight.tracking,
            operationHash,
            receipt: privateReceipt,
        });
        assert.equal(tracked.checkpointSequence, "2");
        assert.equal(trackingRows(), 1, "automatic adoption must not duplicate candidate tasks");
        assert.deepEqual(
            sourceSnapshot(),
            {
                operations: beforeCandidate.operations + 1,
                recognizedNotes: 1,
                checkpoints: 2,
                published: 2,
            },
            "m0 automatic adoption adds one operation checkpoint and no ordinary recognition leaf"
        );
        const adoption = JSON.parse(
            run(
                "sqlite3",
                [
                    "-readonly",
                    join(serviceDir, "provenance.sqlite"),
                    "SELECT json_object('status',t.status,'operationId',t.operation_id,'jobOperationId',adopted.operation_id,'jobStatus',adopted.status,'payload',json(adopted.payload)) FROM confirmation_tracking t JOIN proof_jobs adopted ON adopted.id=t.adopted_job_id",
                ],
                serviceRoot
            ).stdout.trim()
        );
        assert.equal(adoption.status, "recognized");
        assert.equal(adoption.jobStatus, "valid");
        assert.equal(adoption.operationId, adoption.jobOperationId);
        assert.deepEqual(
            adoption.payload.bundle,
            verifiedPreflight.payload.bundle,
            "automatic mined evidence copies the actual native-verified preflight proof"
        );
        save("tracking-native-proof-adoption.json", {
            verifiedPreflightJobId: verifiedPreflight.jobId,
            adoptedOperationId: adoption.operationId,
            bundleSha256: sha(JSON.stringify(adoption.payload.bundle)),
            manualConfirmedProofSubmissions: 0,
            terminalCandidatePayloadMayBePruned: true,
        });
        save("tracking-recognized.json", tracked);
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
        const recognition = await until("withdrawal signed checkpoint", async () => {
            const r = await rpc(serviceURL, "provenance_getOperationRecognition", [operationQuery]);
            return r.recognitionState === "recognized" ? r : null;
        });
        const finalRoots = await rpc(serviceURL, "provenance_getRoots", [
            { after: "0", limit: "20" },
        ]);
        assert.equal(
            finalRoots.items.length,
            2,
            "one automatic recognition appends exactly one checkpoint"
        );
        const finalCert = finalRoots.items.find((c) => c.rootSequence === "2");
        assert(finalCert);
        assert.equal(finalCert.leafCount, "1");
        assert.equal(finalCert.root, cert.root);
        save("relayed-recognition.json", {
            tracking: tracked,
            manualConfirmedProofSubmissions: 0,
            recognition,
            certificate: finalCert,
        });
        step("restart-journal-and-retry-with-provenance-offline");
        await stop(bcProcess);
        children.splice(children.indexOf(bcProcess), 1);
        await stop(serviceProcess);
        children.splice(children.indexOf(serviceProcess), 1);
        bcProcess = start(
            join(bin, "broadcaster"),
            ["run", "--dir", bcDir],
            broadcasterRoot,
            "broadcaster-restarted"
        );
        await until("reopened journal route", () => rpc(bcURL, "broadcaster_getStatus"));
        const resumed = await rpc(bcURL, "broadcaster_submitTransaction", [submission]);
        assert.equal(resumed.id, confirmed.id);
        assert.equal(resumed.transactionHash, confirmed.transactionHash);
        assert.equal(resumed.state, "confirmed");
        assert.equal(
            BigInt(await runtime.rpc("eth_getTransactionCount", [relay.address, "latest"])),
            BigInt(initialNonce) + 1n,
            "journal retry must not replace or increment nonce"
        );
        const offlineQuote = await rpc(bcURL, "broadcaster_getQuote", [{ data }]);
        assert.equal(offlineQuote.provenanceRequired, true);
        save("offline-quote-availability.json", {
            quoteAvailable: true,
            provenanceRequired: offlineQuote.provenanceRequired,
            senderNonce: await runtime.rpc("eth_getTransactionCount", [relay.address, "latest"]),
        });
        save("journal-recovery.json", {
            prior: confirmed,
            resumed,
            provenanceOffline: true,
            sidecarsOmittedOnExactRetry: true,
            senderNonce: await runtime.rpc("eth_getTransactionCount", [relay.address, "latest"]),
            pendingSignedRecovery:
                "covered separately by Broadcaster unit tests; this run checks confirmed durable replay",
        });
        Object.assign(report, {
            realBroadcaster: true,
            realNativeProvenanceVerifier: true,
            sourceRecognitionComplete: true,
            automaticTracking: true,
            trackingId: preflight.tracking.id,
            sourceRestartBetweenPreflightAndBroadcast: true,
            manualConfirmedProofSubmissions: 0,
            manifestSha256: sourceBundle.manifestSha256,
            protocolAddress: protocol,
            transactionHash: confirmed.transactionHash,
            feeAmount: feeAmount.toString(),
            mainCapacity: "1",
            sourceCapacity: "10",
            ordinaryOutputCount: "0",
            journalRecovery: "confirmed replay after daemon restart with Provenance offline",
            completedAt: new Date().toISOString(),
        });
    }
    successful = true;
    step("complete-real-broadcaster-provenance-relay");
} catch (error) {
    report.error = { stage, message: error.message };
    report.failedAt = new Date().toISOString();
    save("report.json", report);
    console.error(error.stack);
    process.exitCode = 1;
} finally {
    clearInterval(finalityMining);
    for (const child of children.reverse()) await stop(child);
    if (tlsProxy) {
        tlsProxy.closeAllConnections();
        await new Promise((resolve) => tlsProxy.close(resolve));
    }
    await runtime?.stop();
    save("report.json", report);
    console.log((successful ? "PASS " : "FAIL ") + directory);
}
