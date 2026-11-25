import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";
import { ProtocolRpcClient } from "../../packages/sdk/dist/index.js";
import { EthersChainReader } from "../../packages/sdk/dist/ethers.js";
import { PublicHistory } from "../../packages/session/dist/index.js";
import { MemoryPublicHistoryStore } from "../../packages/session/dist/memory.js";

const file = new URL("../../examples/05-wallet-session/01-restore-session.ts", import.meta.url);
const source = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;

// Keep the real RPC verification and PublicHistory synchronization. Only the
// transport, chain and storage capabilities are local fixtures; no network or
// account/encryption key files are opened by the actual example main.
async function restore(forged) {
    const hash = "0x" + "11".repeat(32);
    const address = "0x" + "22".repeat(20);
    const block = { number: 1, hash, parentHash: hash, timestamp: 1 };
    const deployment = {
        chainId: 97n,
        protocol: { address, runtimeCodeHash: hash, fromBlock: 1n },
    };
    const calls = [];
    const state = {
        decrypted: false,
        databaseClosed: false,
        providerClosed: false,
        canonicalReads: 0,
        deploymentChecks: 0,
    };
    let history;
    class LocalRpc extends ProtocolRpcClient {
        constructor() {
            super({
                url: "http://local.invalid/v1/chains/97",
                deployment,
                fetch: async (_url, init) => {
                    const request = JSON.parse(init.body);
                    calls.push(request.method);
                    let result;
                    if (request.method === "invisi_getStatus") {
                        result = {
                            apiVersion: "v1",
                            protocolVersion: "1",
                            deployment: {
                                chainId: "97",
                                protocol: { ...deployment.protocol, fromBlock: 1 },
                            },
                            indexedHead: { ...block, hash: forged ? "0x" + "33".repeat(32) : hash },
                        };
                    } else if (request.method === "invisi_getNoteUpdates")
                        result = { blockHash: hash, notes: [] };
                    else if (request.method === "invisi_getCreditTransitions") result = [];
                    else throw Error(`unexpected RPC ${request.method}`);
                    return Response.json({ jsonrpc: "2.0", id: request.id, result });
                },
            });
        }
    }
    class Provider {
        getNetwork = async () => ({ chainId: 97n });
        getBlock = async () => {
            state.canonicalReads++;
            return block;
        };
        getBlockNumber = async () => 1;
        destroy() {
            state.providerClosed = true;
        }
    }
    const protocol = {
        context: { chainId: 97n, protocolAddress: address },
        deployment,
        async validateDeployment() {
            state.deploymentChecks++;
        },
    };
    class HistoryStore extends MemoryPublicHistoryStore {
        constructor() {
            super();
        }
    }
    class Empty {}
    const dependencies = {
        "node:url": { fileURLToPath },
        "node:module": {
            createRequire: () => () => ({
                DatabaseSync: class {
                    close() {
                        state.databaseClosed = true;
                    }
                },
            }),
        },
        ethers: { JsonRpcProvider: Provider, getBytes: () => new Uint8Array(32) },
        "@invisi-labs/session": {
            PublicHistory,
            EncryptedWalletCodec: { fromBytes: async () => ({}) },
            WalletSession: {
                async connect(options) {
                    assert.ok(options.publicHistory instanceof PublicHistory);
                    history = options.publicHistory;
                    return {
                        async refresh() {
                            await history.synchronize();
                            return {
                                async decrypt() {
                                    state.decrypted = true;
                                },
                            };
                        },
                        getScanStatus: async () => ({}),
                        getFundsStatus: async () => ({}),
                        balance: async () => ({}),
                        getHistoryPage: async () => ({}),
                    };
                },
            },
        },
        "@invisi-labs/session/sqlite": {
            SQLiteWalletStore: Empty,
            SQLitePublicHistoryStore: HistoryStore,
        },
        "@invisi-labs/sdk": {
            Invisi: Empty,
            ProtocolRpcClient: LocalRpc,
            Protocol: { fromRpc: async () => protocol },
        },
        "@invisi-labs/sdk/ethers": { EthersChainReader },
        "@invisi-labs/prover/native": { NativeProver: Empty },
        "../settings.js": {
            settings: {
                chainId: 97n,
                chainRpcUrl: "mock:chain",
                protocolRpcUrl: "mock:protocol",
                tokenAddress: address,
            },
        },
        "../accounts.js": { getAccounts: () => [{ publicWallet: {} }] },
        "../example-io.js": { json: () => "public result" },
        "../app-decryptor.js": { decryptor: {} },
    };
    const context = createContext({
        URL,
        console: { log() {} },
        process: { argv: ["node", "restore", "--execute"], env: {} },
    });
    const main = new SourceTextModule(source, {
        context,
        identifier: file.href,
        initializeImportMeta: (meta) => {
            meta.url = file.href;
        },
    });
    await main.link((specifier) => {
        const values = dependencies[specifier];
        assert.ok(values, `unexpected dependency ${specifier}`);
        return new SyntheticModule(
            Object.keys(values),
            function () {
                for (const [key, value] of Object.entries(values)) this.setExport(key, value);
            },
            { context }
        );
    });
    if (forged) await assert.rejects(main.evaluate(), /canonical block mismatch/);
    else await main.evaluate();
    assert.ok(
        state.databaseClosed && state.providerClosed,
        "cleanup must run after success or rejection"
    );
    assert.ok(state.deploymentChecks > 0, "normal deployment validation remains enabled");
    assert.ok(state.canonicalReads > 0, "RPC status must use the independent chain reader");
    assert.equal(state.decrypted, !forged);
    const snapshot = await history.snapshot();
    assert.equal(
        snapshot.pages.length,
        forged ? 0 : 1,
        "forged status must not commit public history"
    );
    assert.ok(calls.includes("invisi_getStatus"));
    if (!forged) assert.ok(calls.includes("invisi_getNoteUpdates"));
}

test("actual restore main binds its PublicHistory RPC and synchronizes canonical history", () =>
    restore(false));
test("actual restore main still rejects a forged RPC head before decryption or history commit", () =>
    restore(true));
