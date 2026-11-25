import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";
import { Invisi, NoteOutput, Protocol, Wallet } from "../../packages/sdk/dist/index.js";
import { MemoryWalletStore, WalletSession } from "../../packages/session/dist/index.js";
import { keccak256 } from "ethers";
import { encodeNoteLogs, noteLogs } from "../note-event-fixtures.js";

const mainFile = new URL(
    "../../examples/05-wallet-session/04-recover-operations.ts",
    import.meta.url
);
const source = ts.transpileModule(readFileSync(mainFile, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const originalHash = `0x${"a6".repeat(32)}` as const;
const otherHash = `0x${"77".repeat(32)}` as const;

// Build a real managed Shield and its frozen call. Only chain/receipt fixtures
// are controlled: Operation.trackTransaction/reconcile/resume are the actual SDK.
async function recoveryFixture(confirmed: boolean) {
    const vectors = JSON.parse(
        readFileSync(
            new URL(
                "../../packages/primitives/src/wallet/testdata/receiving-signature-v1-vectors.json",
                import.meta.url
            ),
            "utf8"
        )
    );
    const wallet = Wallet.fromAddress(vectors.vectors[0].receivingAddress);
    const bob = Wallet.fromAddress(vectors.vectors[1].receivingAddress);
    const context = {
        chainId: 97n,
        protocolAddress: "0x1111111111111111111111111111111111111111" as const,
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
    };
    const block = {
        number: 12n,
        hash: `0x${"12".repeat(32)}` as const,
        parentHash: `0x${"11".repeat(32)}` as const,
        timestamp: 2000000000n,
    };
    const reader: any = {
        getChainId: async () => 97n,
        getCode: async () => "0x6000",
        getLatestBlockNumber: async () => 12n,
        getBlockByTag: async () => block,
        getBlock: async () => block,
        getFundingNonce: async () => 0n,
        getTokenBalanceAllowance: async () => ({ balance: 1000n, allowance: 1000n }),
        isSpent: async (_: unknown, words: unknown[]) => words.map(() => false),
    };
    const protocol = new Protocol({
        deployment: {
            chainId: context.chainId,
            protocol: {
                address: context.protocolAddress,
                runtimeCodeHash: keccak256("0x6000") as `0x${string}`,
                fromBlock: 1n,
            },
        },
    });
    const store = new MemoryWalletStore();
    const session = new WalletSession({
        invisi: new Invisi({ chainReader: reader }),
        wallet,
        protocol,
        store,
        namespace: "confirmed-recovery-test",
    });
    const h = {
        wallet,
        bob,
        context,
        reader,
        protocol,
        store,
        session,
        scope: session.scope,
        options: { wallet },
    };
    const output = await NoteOutput.create({
        ...h.context,
        amount: 100n,
        recipient: { type: "invisi", address: h.bob.getAddress() },
    });
    const ready = await (
        await h.session.prepareShield({
            tokenAddress: h.context.tokenAddress,
            outputs: [output],
            funding: { payer: h.wallet.ownerAddress, amount: 100n, authorization: "caller" },
        })
    ).ready();
    const call = await ready.exportTransaction();
    const snapshot = await h.store.readSnapshot(h.scope);
    const deadline = (snapshot.operations[ready.id]!.payload as { plan: { deadline: bigint } }).plan
        .deadline;
    const logs = encodeNoteLogs(
        noteLogs(
            h.context,
            {
                token: h.context.tokenAddress,
                commitments: [output.commitment],
                deliveries: [output.delivery],
                payer: h.wallet.ownerAddress,
                deposit: 100n,
                deadline,
            },
            { transactionHash: originalHash }
        )
    );
    const reads: string[] = [];
    h.reader.getReceipt = async (hash) => {
        reads.push(hash);
        if (hash !== originalHash && hash !== otherHash) return null;
        return {
            block: await h.reader.getBlock(12n),
            transactionHash: hash,
            status: "success",
            logs,
        };
    };
    const control = { corruptOriginal: false };
    h.reader.getTransaction = async (hash) => ({
        ...call,
        data: hash === otherHash || control.corruptOriginal ? "0x00" : call.data,
        transactionHash: hash,
        from: h.wallet.ownerAddress,
        nonce: 0n,
    });
    if (confirmed)
        assert.equal(
            (await ready.reconcile({ transactionHash: originalHash })).status,
            "confirmed"
        );
    reads.length = 0;
    return { ...h, ready, reads, control };
}

async function runMain(h: Awaited<ReturnType<typeof recoveryFixture>>, hostHash?: unknown) {
    const events: string[] = [],
        logs: unknown[][] = [];
    let closed = 0;
    const operation = (value: any): any => ({
        get status() {
            return value.status;
        },
        async trackTransaction(hash: string) {
            events.push(`track:${hash}`);
            return operation(await value.trackTransaction(hash));
        },
        async reconcile(options?: { transactionHash?: string }) {
            events.push(`reconcile:${options?.transactionHash ?? "journal"}`);
            return value.reconcile(options);
        },
    });
    const session = {
        getHistory: () => h.session.getHistory(),
        refresh: async () => ({ async decrypt() {} }),
        resume: async (id: string) => operation(await h.session.resume(id)),
    };
    class Empty {}
    class Provider {
        getNetwork = async () => ({ chainId: h.context.chainId });
        destroy() {
            closed++;
        }
    }
    const dependencies: Record<string, Record<string, unknown>> = {
        "node:url": { fileURLToPath },
        "node:module": {
            createRequire: () => () => ({
                DatabaseSync: class {
                    close() {
                        closed++;
                    }
                },
            }),
        },
        ethers: { JsonRpcProvider: Provider, getBytes: () => new Uint8Array(32) },
        "@invisi-labs/session": {
            WalletSession: { connect: async () => session },
            EncryptedWalletCodec: { fromBytes: async () => ({}) },
        },
        "@invisi-labs/session/sqlite": { SQLiteWalletStore: Empty },
        "@invisi-labs/sdk": {
            Invisi: Empty,
            Protocol: { fromRpc: async () => h.protocol },
            ProtocolRpcClient: Empty,
        },
        "@invisi-labs/prover/native": { NativeProver: Empty },
        "../settings.js": {
            settings: {
                chainId: h.context.chainId,
                chainRpcUrl: "mock:chain",
                protocolRpcUrl: "mock:protocol",
            },
        },
        "../accounts.js": {
            getAccounts: () => [{ name: "alice", publicWallet: h.options.wallet }],
        },
        "../app-decryptor.js": { decryptor: {} },
    };
    const context = createContext({
        URL,
        console: { log: (...args: unknown[]) => logs.push(args) },
        process: {
            argv: ["node", "recovery", "--execute"],
            env: {
                HOST_TRANSACTIONS_JSON: JSON.stringify(
                    hostHash === undefined ? {} : { [h.ready.id]: hostHash }
                ),
            },
        },
    });
    const main = new SourceTextModule(source, {
        context,
        identifier: mainFile.href,
        initializeImportMeta: (meta) => {
            meta.url = mainFile.href;
        },
    });
    await main.link((specifier) => {
        const exports = dependencies[specifier];
        assert.ok(exports, `unexpected dependency ${specifier}`);
        return new SyntheticModule(
            Object.keys(exports),
            function () {
                for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
            },
            { context }
        );
    });
    try {
        await main.evaluate();
    } finally {
        assert.equal(closed, 2, "database/provider cleanup must run even after rejection");
    }
    return { events, logs };
}

test("real SDK rejects tracking an already confirmed operation", async () => {
    const h = await recoveryFixture(true);
    const confirmed = await h.session.resume(h.ready.id);
    await assert.rejects(confirmed.trackTransaction(originalHash), /operation is not ready/);
});

test("actual recovery main can reconcile the original confirmed hash repeatedly", async () => {
    const h = await recoveryFixture(true);
    for (let repeat = 0; repeat < 2; repeat++) {
        const result = await runMain(h, originalHash);
        assert.deepEqual(result.events, [`reconcile:${originalHash}`]);
        assert.ok(
            result.logs.some(
                (line) =>
                    line[0] === "Recovered operation:" &&
                    line[1] === h.ready.id &&
                    line[2] === "confirmed"
            )
        );
    }
    assert.deepEqual(h.reads, [originalHash, originalHash]);
});

test("actual recovery main rejects a different hash for an already confirmed operation", async () => {
    const h = await recoveryFixture(true);
    await assert.rejects(
        runMain(h, otherHash),
        /host transaction hash differs from the confirmed operation/i
    );
    assert.deepEqual(h.reads, []);
    const state = await h.store.readSnapshot(h.scope);
    assert.equal(state.operations[h.ready.id]!.transactionHash, originalHash);
    assert.equal(state.operations[h.ready.id]!.status, "confirmed");
});

test("actual confirmed recovery rejects an unknown host hash without downgrading the journal", async () => {
    const h = await recoveryFixture(true);
    await assert.rejects(
        runMain(h, `0x${"88".repeat(32)}`),
        /host transaction hash differs from the confirmed operation/i
    );
    assert.deepEqual(h.reads, []);
    const record = (await h.store.readSnapshot(h.scope)).operations[h.ready.id]!;
    assert.equal(record.status, "confirmed");
    assert.equal(record.transactionHash, originalHash);
});

test("actual confirmed recovery still checks the same hash's canonical frozen calldata", async () => {
    const h = await recoveryFixture(true);
    h.control.corruptOriginal = true;
    await assert.rejects(
        runMain(h, originalHash),
        /confirmed transaction differs from the frozen operation/
    );
    assert.deepEqual(h.reads, [originalHash]);
});

for (const status of ["ready", "uncertain", "submitted"] as const)
    test(`actual recovery main tracks a ${status} crash-recovery hash before reconciliation`, async () => {
        const h = await recoveryFixture(false);
        if (status !== "ready") await h.ready.trackTransaction(originalHash);
        if (status === "submitted")
            await h.store.transaction(h.scope, (state) => {
                state.operations[h.ready.id]!.status = "submitted";
            });
        const result = await runMain(h, originalHash);
        assert.deepEqual(result.events, [`track:${originalHash}`, `reconcile:${originalHash}`]);
        assert.equal(
            (await h.store.readSnapshot(h.scope)).operations[h.ready.id]!.status,
            "confirmed"
        );
    });

test("actual confirmed recovery normalizes equivalent uppercase host hashes", async () => {
    const h = await recoveryFixture(true);
    const result = await runMain(h, "0x" + originalHash.slice(2).toUpperCase());
    assert.deepEqual(result.events, [`reconcile:${originalHash}`]);
    assert.equal((await h.store.readSnapshot(h.scope)).operations[h.ready.id]!.status, "confirmed");
});

test("actual recovery main uses the journal hash when no host hash is supplied", async () => {
    const h = await recoveryFixture(true);
    const result = await runMain(h);
    assert.deepEqual(result.events, ["reconcile:journal"]);
    assert.deepEqual(h.reads, [originalHash]);
});

for (const invalidHash of [null, "not-a-hash", 123])
    test(`actual confirmed recovery rejects invalid host hash ${JSON.stringify(invalidHash)}`, async () => {
        const h = await recoveryFixture(true);
        await assert.rejects(runMain(h, invalidHash), /invalid transaction hash/);
        assert.deepEqual(h.reads, []);
    });
