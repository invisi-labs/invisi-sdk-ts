import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";

const scenarios = [
    ["05-wallet-session/02-own-cash-to-bob.ts", ["ready"]],
    ["05-wallet-session/03-own-notes-with-change.ts", ["sign", "prove"]],
    ["05-wallet-session/08-revoke-credit.ts", ["ready"]],
    ["07-broadcaster/01-prepare-and-broadcast.ts", ["quote", "sign", "prove", "ready", "submit"]],
    ["07-broadcaster/02-pre-submit-provenance.ts", ["sign", "prove", "ready", "send"]],
    ["07-broadcaster/03-recover-and-submit-provenance.ts", ["sign", "prove", "ready", "send"]],
    [
        "07-broadcaster/04-scheduled-cancel-recovery.ts",
        ["quote", "sign", "prove", "ready", "submit"],
    ],
];
const sources = new Map();

// Execute each actual main, replacing only its external capabilities. No SDK,
// wallet key, filesystem-backed database, proof backend or RPC is opened by it.
async function runMain(path, fault) {
    const id = "original-persisted-operation";
    const records = new Map();
    const logs = [];
    let failedAt,
        exports = 0,
        sends = 0,
        prepares = 0;
    const inject = (stage) => {
        if (stage === fault) {
            failedAt = stage;
            throw new Error(`injected ${stage} failure`);
        }
    };
    const transaction = { hash: "transaction-hash", async wait() {} };
    const send = async () => {
        inject("send");
        sends++;
        return transaction;
    };
    const operation = {
        id,
        preview: () => ({}),
        estimateGas: () => ({}),
        broadcasterQuote: () => ({ quote: { execution: "direct" } }),
        broadcasterScheduleHandle: () => ({}),
        async exportWalletAuthorization() {
            return { domain: {}, types: {}, message: {} };
        },
        async withWalletSignature() {
            return operation;
        },
        async prove() {
            inject("prove");
            return operation;
        },
        async ready() {
            inject("ready");
            return operation;
        },
        async exportTransaction() {
            exports++;
            return { to: "protocol", data: "0x1234" };
        },
        async trackTransaction() {
            return operation;
        },
    };
    const prepare = async () => {
        inject("prepare");
        prepares++;
        records.set(id, { status: "prepared" });
        return operation;
    };
    const address = "0x1111111111111111111111111111111111111111";
    const tokenAddress = "0x2222222222222222222222222222222222222222";
    const snapshot = {
        credits: {
            grant: {
                role: "owner",
                commitment: "commitment",
                spent: "unspent",
                revoked: false,
                state: {
                    note: {
                        tokenAddress: BigInt(tokenAddress),
                        expiry: 999999999999n,
                        grantId: 7n,
                    },
                },
            },
        },
        reservations: {},
    };
    const session = {
        scope: {},
        getHistory: async () => ({ outgoing: [] }),
        refresh: async () => ({ async decrypt() {} }),
        balance: async () => ({ availableKnown: 100n }),
        prepareShield: prepare,
        prepareTransfer: prepare,
        prepareRevokeCredit: prepare,
        sendTransaction: send,
        resume: async () => operation,
    };
    const client = {
        configuration: { feeRecipient: address },
        async quote() {
            inject("quote");
            return operation;
        },
        async submit() {
            inject("submit");
            sends++;
            return { id: "relay-id", state: "scheduled" };
        },
        recoverScheduled: async () => ({}),
        cancel: async () => ({}),
    };
    const protocol = {
        context: { chainId: 97n, protocolAddress: address },
        deployment: { protocol: { fromBlock: 1n } },
        getBroadcasters: async () => [client],
    };
    class Empty {}
    class Provider {
        getNetwork = async () => ({ chainId: 97n });
        getBlock = async () => ({ timestamp: 1 });
        estimateGas = async () => 100000n;
        destroy() {}
    }
    class Signer {
        address = address;
        async signTypedData() {
            inject("sign");
            return "signature";
        }
        sendTransaction = send;
    }
    class Store {
        readSnapshot = async () => snapshot;
    }
    class Provenance {
        prove = async () => ({ operationDigest: "digest", context: {} });
        submit = async () => ({
            broadcastDecision: "allow",
            tracking: { id: "tracking", operationDigest: "digest" },
        });
    }
    const account = (name) => ({
        name,
        address,
        receivingAddress: "public-receiving-address",
        publicWallet: { ownerAddress: address },
    });
    const dependencies = {
        "node:url": { fileURLToPath },
        "node:module": {
            createRequire: () => () => ({
                DatabaseSync: class {
                    close() {}
                },
            }),
        },
        ethers: {
            JsonRpcProvider: Provider,
            Wallet: Signer,
            Contract: class {
                decimals = async () => 18;
            },
            getBytes: () => new Uint8Array(32),
            parseUnits: () => 1n,
        },
        "@invisi-labs/session": {
            WalletSession: { connect: async () => session },
            EncryptedWalletCodec: { fromBytes: async () => ({}) },
            creditReservationKey: () => "reservation",
        },
        "@invisi-labs/session/sqlite": { SQLiteWalletStore: Store },
        "@invisi-labs/session/memory": { MemoryWalletStore: Empty },
        "@invisi-labs/sdk": {
            Invisi: Empty,
            Protocol: { fromRpc: async () => protocol },
            ProtocolRpcClient: Empty,
            NoteOutput: { create: async () => ({}) },
            readTransactionConfirmation: async () => ({}),
        },
        "@invisi-labs/sdk/ethers": { EthersChainReader: Empty },
        "@invisi-labs/sdk/provenance": {
            Provenance,
            officialProvenanceClient: async () => ({ waitTracking: async () => ({}) }),
        },
        "@invisi-labs/prover/native": { NativeProver: Empty },
        "../settings.js": {
            settings: {
                chainId: 97n,
                chainRpcUrl: "mock:rpc",
                protocolRpcUrl: "mock:protocol",
                tokenAddress,
                broadcasterMaxFeeAmount: 1n,
            },
        },
        "../accounts.js": { getAccounts: () => [account("alice"), account("bob")] },
        "../example-io.js": { json: () => "public result" },
        "../app-decryptor.js": { decryptor: {} },
    };
    const context = createContext({
        URL,
        console: { log: (...args) => logs.push(args) },
        process: {
            argv: ["node", path, "--execute"],
            env: {},
            exit: () => {
                throw Error("unexpected early exit");
            },
        },
    });
    const file = new URL(`../../examples/${path}`, import.meta.url);
    if (!sources.has(path))
        sources.set(
            path,
            ts.transpileModule(readFileSync(file, "utf8"), {
                compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
            }).outputText
        );
    const main = new SourceTextModule(sources.get(path), {
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
    if (fault) await assert.rejects(main.evaluate(), { message: `injected ${fault} failure` });
    else await main.evaluate();
    assert.equal(failedAt, fault);
    assert.equal(prepares, fault === "prepare" ? 0 : 1);
    const idLogs = logs.filter((args) => args[1] === id);
    assert.equal(
        idLogs.length,
        fault === "prepare" ? 0 : 1,
        "the original persisted ID must be logged once even when a later stage fails"
    );
    if (fault !== "prepare")
        assert.ok(records.has(id), "logged ID must identify the prepared journal");
    if (fault) {
        assert.equal(sends, 0, "failure must not send a replacement payment");
        if (!["send", "submit"].includes(fault)) assert.equal(exports, 0);
    }
}

for (const [path, faults] of scenarios) {
    for (const fault of ["prepare", ...faults])
        test(`${path}: retains the original ID after ${fault} failure`, () => runMain(path, fault));
    test(`${path}: logs the prepared ID exactly once on success`, () => runMain(path));
}
