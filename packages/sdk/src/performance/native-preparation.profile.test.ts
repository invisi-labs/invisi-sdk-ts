import { expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import { join, resolve } from "node:path";
import { JsonRpcProvider, Wallet as EthersWallet, keccak256 } from "ethers";
import { Invisi, Protocol, ProtocolRpcClient, NoteOutput, Wallet } from "@invisi-labs/sdk";
import { EthersChainReader } from "@invisi-labs/sdk/ethers";
import { NativeProver, verifyWithBB, getCircuitMetadata } from "@invisi-labs/prover/native";
import { WalletSession } from "../../../session/src/wallet/WalletSession";
import { EncryptedWalletCodec } from "../../../session/src/storage/encrypted-codec";
import {
    SQLiteWalletStore,
    SQLitePublicHistoryStore,
    type SQLiteConnection,
} from "../../../session/src/storage/sqlite";
import { PublicHistory } from "../../../session/src/public-history/history";
import * as captures from "../../../session/src/sync/preparation-capture";
import * as snapshots from "../../../session/src/sync/preparation-snapshot";
import { testDecryptor } from "../../../../test-support/native-wallet";
import { TestWallet } from "../../../../test-support/test-wallet";
import type { SavedOperation } from "@invisi-labs/sdk/session-support";
import type { Hex } from "@invisi-labs/protocol/contracts";

type Sample = {
    mode: "uncached" | "offline";
    round: number;
    timings: Record<string, number>;
    requests: Record<string, Record<string, number>>;
    proofBytes?: number;
    proofSha256?: string;
    contractVerified?: boolean;
};
const profile = process.env.INVISI_NATIVE_PREPARATION_PROFILE ? it : it.skip;
profile(
    "compares genuine C20 preparation with an uncached reader and a reopened offline wallet",
    async () => {
        const directory = resolve(process.env.INVISI_NATIVE_PREPARATION_PROFILE!);
        const root = resolve(process.cwd(), "../../../invisi-protocol");
        const rpcRoot = resolve(root, "../invisi-protocol-rpc");
        const bbBin = join(root, ".tools/bb/bb"),
            crsPath = resolve(process.env.HOME!, ".bb-crs");
        mkdirSync(directory, { recursive: true });
        const options = { bbBin, crsPath, threads: 4 };
        const native = new NativeProver(options);
        const nativeVersion = execFileSync(bbBin, ["--version"], { encoding: "utf8" }).trim();
        expect(nativeVersion).toBe("6.0.0");
        const report = {
            startedAt: new Date().toISOString(),
            node: process.version,
            platform: process.platform,
            arch: process.arch,
            bb: nativeVersion,
            threads: 4,
            protocol: execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: root,
                encoding: "utf8",
            }).trim(),
            sdk: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
            circuit: (() => {
                const circuit = getCircuitMetadata("transact_user_slots20");
                return {
                    name: circuit.name,
                    capacity: circuit.capacity,
                    artifactSha256: circuit.artifactSha256,
                    vkSha256: circuit.keys.evm!.vkSha256,
                };
            })(),
            realProofs: true,
            realChain: true,
            realProtocolRPC: true,
            delayInjectedMs: 0,
            storage: "AES-GCM SQLite",
            samples: [] as Sample[],
        };
        const save = () =>
            writeFileSync(
                join(directory, "timings.json"),
                JSON.stringify(
                    report,
                    (_, value) => (typeof value === "bigint" ? value.toString() : value),
                    2
                )
            );
        save();
        console.log("native-c20: building real Protocol RPC");
        const binary = join(directory, "protocol-rpc");
        execFileSync("go", ["build", "-mod=readonly", "-o", binary, "./cmd"], {
            cwd: rpcRoot,
            stdio: "pipe",
        });
        const modulePath = join(root, "scripts/settlement-fixtures/runtime.mjs");
        const { createSettlementRuntime } = await import(modulePath);
        console.log("native-c20: deploying real protocol release");
        const runtime = await createSettlementRuntime({
            root,
            directory: join(directory, "chain"),
            timestamp: "wall-clock",
        });
        let rpcProcess: ChildProcess | undefined;
        let provider: JsonRpcProvider | undefined;
        let offline = false;
        let stage = "setup";
        let counts: Record<string, number> = {};
        let snapshotEnabled = true;
        const capture = captures.createPreparationCapture;
        const captureSpy = vi
            .spyOn(captures, "createPreparationCapture")
            .mockImplementation(() => (snapshotEnabled ? capture() : undefined));
        const retain = snapshots.retainPreparationSnapshot;
        const spy = vi
            .spyOn(snapshots, "retainPreparationSnapshot")
            .mockImplementation(async (...args) => {
                if (snapshotEnabled) await retain(...args);
            });
        const increment = (method: string) => {
            counts[method] = (counts[method] ?? 0) + 1;
        };
        try {
            const node = JSON.parse(readFileSync(join(directory, "chain/node.json"), "utf8"));
            provider = new JsonRpcProvider(node.url, undefined, {
                cacheTimeout: -1,
                batchMaxCount: 1,
            });
            const send = provider.send.bind(provider);
            provider.send = async (method, params) => {
                if (offline) throw Error(`offline network access in ${stage}: ${method}`);
                return send(method, params);
            };
            const physicalSend = provider._send.bind(provider);
            provider._send = async (payload) => {
                for (const request of Array.isArray(payload) ? payload : [payload])
                    increment("chain." + request.method);
                if (offline) throw Error(`offline physical transport access in ${stage}`);
                return physicalSend(payload);
            };
            const deploymentData = JSON.parse(
                readFileSync(join(directory, "chain/deployment.json"), "utf8")
            );
            const deployed = deploymentData.deployments.find(
                (d: { name: string }) => d.name === "InvisiProtocol"
            );
            const fromBlock = Number(BigInt(deployed.receipt.blockNumber));
            const deployment = {
                chainId: 31337n,
                protocol: {
                    address: runtime.protocol as Hex,
                    runtimeCodeHash: keccak256(await provider.getCode(runtime.protocol)) as Hex,
                    fromBlock: BigInt(fromBlock),
                },
            };
            const listener = createServer();
            await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
            const port = (listener.address() as { port: number }).port;
            await new Promise<void>((r) => listener.close(() => r()));
            const rpcDirectory = join(directory, "rpc");
            execFileSync(binary, ["init", "--dir", rpcDirectory, "--listen", `127.0.0.1:${port}`], {
                cwd: rpcRoot,
                stdio: "pipe",
            });
            const config = {
                listen: `127.0.0.1:${port}`,
                maxConcurrentRequests: 16,
                chains: [
                    {
                        chainRpc: node.url,
                        database: { driver: "sqlite", path: join(rpcDirectory, "index.sqlite") },
                        pollSeconds: 1,
                        snapshotInterval: "0s",
                        deployment: {
                            chainId: "31337",
                            protocol: {
                                ...deployment.protocol,
                                fromBlock,
                                runtimeCodeHash: deployment.protocol.runtimeCodeHash,
                            },
                        },
                    },
                ],
            };
            writeFileSync(join(rpcDirectory, "config.json"), JSON.stringify(config));
            const fd = openSync(join(directory, "rpc.log"), "w");
            rpcProcess = spawn(binary, ["run", "--dir", rpcDirectory], {
                cwd: rpcRoot,
                stdio: ["ignore", fd, fd],
            });
            closeSync(fd);
            const transport: typeof fetch = async (...args) => {
                increment("protocol.http");
                if (offline) throw Error(`offline Protocol RPC access in ${stage}`);
                return fetch(...args);
            };
            const protocolRpc = new ProtocolRpcClient({
                url: `http://127.0.0.1:${port}/v1/chains/31337`,
                deployment,
                reader: new EthersChainReader(provider),
                fetch: transport,
            });
            const protocol = new Protocol({ deployment });
            const invisi = new Invisi({
                provider,
                chainReader: new EthersChainReader(provider),
                protocolRpc,
                prover: native,
            });
            const alice = await TestWallet.fromPrivateKey(new Uint8Array(32).fill(1));
            const bob = await TestWallet.fromPrivateKey(new Uint8Array(32).fill(2));
            const signer = new EthersWallet(`0x${"01".repeat(32)}`);
            expect(signer.address.toLowerCase()).toBe(alice.ownerAddress.toLowerCase());
            const tokenAddress = runtime.tokens[0] as Hex;
            const context = { ...protocol.context, tokenAddress };
            const waitIndexed = async (number: bigint) => {
                let last: unknown;
                for (let attempt = 0; attempt < 160; attempt++) {
                    if (rpcProcess?.exitCode !== null)
                        throw Error("Protocol RPC exited before indexing");
                    try {
                        if (
                            (await protocolRpc.getStatus(protocol.context)).indexedHead!.number >=
                            number
                        )
                            return;
                    } catch (error) {
                        last = error;
                    }
                    await new Promise((r) => setTimeout(r, 250));
                }
                throw Error("Protocol RPC indexing timeout: " + String(last));
            };
            await waitIndexed(BigInt(fromBlock));
            console.log("native-c20: creating ten genuine Shield inputs");
            const seedOutputs = await Promise.all(
                Array.from({ length: 10 }, () =>
                    NoteOutput.create({
                        ...context,
                        amount: 100n,
                        recipient: { type: "invisi", address: alice.getAddress() },
                    })
                )
            );
            await runtime.tx(
                "mint-inputs",
                tokenAddress,
                runtime.token.encodeFunctionData("mint", [runtime.sender, 1000n])
            );
            await runtime.tx(
                "approve-inputs",
                tokenAddress,
                runtime.token.encodeFunctionData("approve", [runtime.protocol, 1000n])
            );
            const seed = await invisi.prepareShield({
                wallet: Wallet.fromAddress(alice.getAddress()),
                protocol,
                tokenAddress,
                outputs: seedOutputs,
                funding: { payer: runtime.sender as Hex, amount: 1000n, authorization: "caller" },
            });
            const seedCall = await (await seed.ready()).exportTransaction();
            const shieldReceipt = await runtime.tx("shield-ten-inputs", seedCall.to, seedCall.data);
            await waitIndexed(BigInt(shieldReceipt.blockNumber));
            const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
                DatabaseSync: new (path: string) => SQLiteConnection & { close(): void };
            };
            const codec = await EncryptedWalletCodec.fromBytes(new Uint8Array(32).fill(7));
            const warmKey = { wallet: Wallet.fromAddress(alice.getAddress()), protocol, invisi };
            const makeOutputs = () =>
                Promise.all(
                    Array.from({ length: 10 }, () =>
                        NoteOutput.create({
                            ...context,
                            amount: 100n,
                            recipient: { type: "invisi", address: bob.getAddress() },
                        })
                    )
                );
            const run = async (mode: Sample["mode"], round: number) => {
                const sample: Sample = { mode, round, timings: {}, requests: {} };
                report.samples.push(sample);
                snapshotEnabled = mode === "offline";
                offline = false;
                const db = new DatabaseSync(join(directory, `${mode}-${round}.sqlite`));
                const createStore = () => new SQLiteWalletStore(db, codec);
                const publicStore = new SQLitePublicHistoryStore(db);
                const history = new PublicHistory({
                    protocol,
                    reader: invisi.getInfrastructure().chainReader!,
                    protocolRpc: invisi.getInfrastructure().protocolRpc!,
                    store: publicStore,
                });
                const time = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
                    stage = name;
                    counts = {};
                    const start = performance.now();
                    try {
                        return await work();
                    } finally {
                        sample.timings[name] = performance.now() - start;
                        sample.requests[name] = { ...counts };
                        save();
                    }
                };
                try {
                    let session!: WalletSession;
                    await time("sync", async () => {
                        session = await WalletSession.connect({
                            ...warmKey,
                            store: createStore(),
                            publicHistory: history,
                            namespace: "native-c20",
                        });
                        const pending = await session.refresh();
                        await pending.decrypt(testDecryptor);
                    });
                    const stored = await createStore().readSnapshot(session.scope);
                    expect(Object.values(stored.notes)).toHaveLength(10);
                    expect(Boolean(stored.preparationSnapshot)).toBe(mode === "offline");
                    offline = mode === "offline";
                    const outputs = await time("outputs", makeOutputs);
                    const prepared = await time("prepare", async () => {
                        session = await WalletSession.connect({
                            ...warmKey,
                            store: createStore(),
                            publicHistory: history,
                            namespace: "native-c20",
                        });
                        return session.prepareTransfer({ tokenAddress, outputs });
                    });
                    expect(prepared.preview()).toMatchObject({ inputs: 10, capacity: 20 });
                    expect(prepared.getOutputs()).toHaveLength(10);
                    const authorized = await time("sign", async () => {
                        const request = await prepared.exportWalletAuthorization();
                        return prepared.withWalletSignature(
                            await signer.signTypedData(
                                request.domain,
                                request.types,
                                request.message
                            )
                        );
                    });
                    const ready = await time("prove", () => authorized.prove());
                    const call = await time("export", () => ready.exportTransaction());
                    if (mode === "offline")
                        for (const phase of ["outputs", "prepare", "sign", "prove", "export"])
                            expect(sample.requests[phase]).toEqual({});
                    const payload = (await createStore().readSnapshot(session.scope)).operations[
                        ready.id
                    ]!.payload as SavedOperation;
                    const proof = payload.proof!;
                    expect(proof.circuitName).toBe("transact_user_slots20");
                    expect(proof.proofHex.length).toBeGreaterThan(1000);
                    expect(
                        await time("independentVerify", () => verifyWithBB(proof, options))
                    ).toBe(true);
                    sample.proofBytes = (proof.proofHex.length - 2) / 2;
                    sample.proofSha256 = proof.proofSha256;
                    offline = false;
                    await time("submissionCheck", () => ready.validateSubmission());
                    await time("contractVerify", () =>
                        provider!.call({
                            from: runtime.sender,
                            to: call.to,
                            data: call.data,
                            gasLimit: 16_777_216n,
                        })
                    );
                    sample.contractVerified = true;
                    save();
                    console.log(
                        "native-c20 sample",
                        JSON.stringify({
                            mode,
                            round,
                            timings: sample.timings,
                            requests: sample.requests,
                        })
                    );
                } finally {
                    offline = false;
                    db.close();
                }
            };
            console.log("native-c20: warmup");
            await run("uncached", 0);
            for (let round = 1; round <= 3; round++) {
                for (const mode of round % 2
                    ? (["uncached", "offline"] as const)
                    : (["offline", "uncached"] as const))
                    await run(mode, round);
            }
            save();
        } finally {
            offline = false;
            spy.mockRestore();
            captureSpy.mockRestore();
            provider?.destroy();
            if (rpcProcess && rpcProcess.exitCode === null) {
                const stopped = new Promise((r) => rpcProcess!.once("exit", r));
                rpcProcess.kill("SIGTERM");
                await stopped;
            }
            await runtime.stop();
        }
    },
    900_000
);
