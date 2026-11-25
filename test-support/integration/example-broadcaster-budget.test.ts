import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";
import { createHash } from "node:crypto";
import { keccak256 } from "ethers";
import {
    BroadcasterClient,
    Invisi,
    NoteOutput,
    Protocol,
    Wallet,
} from "../../packages/sdk/dist/index.js";
import { MemoryWalletStore, WalletSession } from "../../packages/session/dist/index.js";
import { MerkleFixture } from "../merkle-fixture.js";
import { quoteClient } from "../broadcaster-fixture.js";

const unit = 10n ** 18n;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as const;
async function fixture(fee = unit / 10n) {
    const vectors = JSON.parse(
        readFileSync(
            new URL(
                "../../packages/primitives/src/wallet/testdata/receiving-signature-v1-vectors.json",
                import.meta.url
            ),
            "utf8"
        )
    ).vectors;
    const wallet = Wallet.fromAddress(vectors[0].receivingAddress);
    const bob = Wallet.fromAddress(vectors[1].receivingAddress);
    const context = {
        chainId: 97n,
        protocolAddress: "0x1111111111111111111111111111111111111111" as const,
        tokenAddress: "0x2222222222222222222222222222222222222222" as const,
    };
    const block = {
        number: 12n,
        hash: word(12n),
        parentHash: word(11n),
        timestamp: BigInt(Math.floor(Date.now() / 1000)),
    };
    const tree = await MerkleFixture.create();
    const notes = await Promise.all(
        [0, 1].map(() =>
            NoteOutput.create({
                ...context,
                amount: 10n * unit,
                recipient: { type: "invisi", address: wallet.getAddress() },
            })
        )
    );
    for (const note of notes) await tree.insert(BigInt(note.commitment));
    const reader: any = {
        getChainId: async () => 97n,
        getCode: async () => "0x6000",
        getLatestBlockNumber: async () => 12n,
        getBlockByTag: async () => block,
        getBlock: async () => block,
        isKnownRoot: async () => true,
        isSpent: async (_: unknown, words: unknown[]) => words.map(() => false),
    };
    const membership: any = {
        getMembership: async (_: unknown, input: any) => {
            const proof = tree.getProof(input.leafIndex);
            return {
                treeId: 1n,
                leafIndex: input.leafIndex,
                leaf: word(tree.getLeaf(input.leafIndex)),
                root: word(proof.root),
                path: proof.merklePath,
                block,
            };
        },
    };
    const protocol = new Protocol({
        deployment: {
            chainId: 97n,
            protocol: {
                address: context.protocolAddress,
                runtimeCodeHash: keccak256("0x6000") as `0x${string}`,
                fromBlock: 1n,
            },
        },
    });
    const store = new MemoryWalletStore();
    const session = new WalletSession({
        invisi: new Invisi({
            chainReader: reader,
            protocolRpc: membership,
            prover: {
                prove: async (request: any) => ({
                    ...structuredClone(request),
                    formatVersion: 1,
                    bbVersion: "6.0.0",
                    proofHex: "0x00",
                    proofSha256: createHash("sha256")
                        .update(new Uint8Array([0]))
                        .digest("hex"),
                    publicInputs: [...request.expectedPublicInputs],
                }),
                verify: async () => true,
            },
        }),
        wallet,
        protocol,
        store,
        namespace: "budget-test",
    });
    await store.transaction(session.scope, (state) => {
        notes.forEach((output, leafIndex) => {
            state.notes[output.commitment] = {
                note: output.note,
                commitment: output.commitment,
                treeId: 1n,
                leafIndex,
                blockNumber: 12n,
                blockHash: block.hash,
                spent: "unspent",
            };
        });
        state.observedThrough = { number: 12n, hash: block.hash };
    });
    return {
        wallet,
        bob,
        context,
        reader,
        membership,
        protocol,
        store,
        session,
        client: quoteClient(context, () => fee),
    };
}

test("real SDK reproduces exact single-Note selection without a prepared fee budget", async () => {
    const h = await fixture();
    const output = await NoteOutput.create({
        ...h.context,
        amount: 10n * unit,
        recipient: { type: "invisi", address: h.bob.getAddress() },
    });
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
    });
    assert.equal(
        (await h.store.readSnapshot(h.session.scope)).operations[prepared.id]!.inputs.length,
        1
    );
    await assert.rejects(
        h.client.quote(prepared, { maxFeeAmount: unit }),
        /Fee exceeds prepared private funds/
    );
});

async function runMain(
    file: string,
    h: Awaited<ReturnType<typeof fixture>>,
    recovery?: { operationId: string; recoverSubmitId?: boolean }
) {
    const logs: unknown[][] = [];
    let signed = 0,
        closed = 0,
        prepared = 0,
        quoted: any;
    const quote = h.client.quote.bind(h.client);
    h.client.quote = async (...args: Parameters<typeof quote>) => {
        quoted = await quote(...args);
        return quoted;
    };
    const session = {
        refresh: async () => ({ decrypt: async () => {} }),
        balance: h.session.balance.bind(h.session),
        scope: h.session.scope,
        resume: h.session.resume.bind(h.session),
        prepareTransfer: (...args: Parameters<typeof h.session.prepareTransfer>) => {
            prepared++;
            if (recovery) throw Error("Recovery must not prepare a new payment");
            return h.session.prepareTransfer(...args);
        },
    };
    const protocol = {
        context: h.protocol.context,
        deployment: h.protocol.deployment,
        getBroadcasters: async () => {
            if (recovery) throw Error("Recovery must use its saved broadcaster configuration");
            return [h.client];
        },
    };
    class Empty {}
    class Provider {
        getNetwork = async () => ({ chainId: 97n });
        destroy() {
            closed++;
        }
    }
    class Signer {
        constructor() {
            if (recovery) throw Error("Recovery must not open an account signing key");
        }
        address = h.wallet.ownerAddress;
        async signTypedData() {
            signed++;
            throw Error("STOP_BEFORE_SIGNING");
        }
    }
    const dependencies: Record<string, Record<string, unknown>> = {
        "node:module": {
            createRequire: () => () => ({
                DatabaseSync: class {
                    close() {
                        closed++;
                    }
                },
            }),
        },
        "node:url": { fileURLToPath },
        ethers: { JsonRpcProvider: Provider, Wallet: Signer, getBytes: () => new Uint8Array(32) },
        "@invisi-labs/sdk/ethers": { EthersChainReader: Empty },
        "@invisi-labs/sdk": {
            BroadcasterClient: class {
                constructor(configuration: unknown) {
                    assert.deepEqual(configuration, h.client.configuration);
                    return h.client;
                }
            },
            Invisi: Empty,
            Protocol: { fromRpc: async () => protocol },
            ProtocolRpcClient: Empty,
            NoteOutput,
            readTransactionConfirmation: () => {
                throw Error("unexpected chain submission");
            },
        },
        "@invisi-labs/prover/native": { NativeProver: Empty },
        "@invisi-labs/session": {
            WalletSession: { connect: async () => session },
            EncryptedWalletCodec: { fromBytes: async () => ({}) },
        },
        "@invisi-labs/session/memory": { MemoryWalletStore: Empty },
        "@invisi-labs/session/sqlite": {
            SQLiteWalletStore: class {
                readSnapshot = h.store.readSnapshot.bind(h.store);
            },
        },
        "../settings.js": { settings: { ...h.context, broadcasterMaxFeeAmount: unit } },
        "../accounts.js": {
            getAccounts: () => [
                { publicWallet: h.wallet },
                { receivingAddress: h.bob.getAddress() },
            ],
        },
        "../example-io.js": { json: (v: unknown) => v },
        "../app-decryptor.js": { decryptor: {} },
    };
    const url = new URL(`../../examples/07-broadcaster/${file}`, import.meta.url);
    const source = ts.transpileModule(readFileSync(url, "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText;
    const context = createContext({
        URL,
        console: { log: (...args: unknown[]) => logs.push(args) },
        process: {
            argv: [
                "node",
                "example",
                "--execute",
                ...(recovery?.recoverSubmitId ? ["--recover-submit-id"] : []),
            ],
            env: recovery ? { OPERATION_ID: recovery.operationId } : {},
        },
    });
    const main = new SourceTextModule(source, {
        context,
        identifier: url.href,
        initializeImportMeta: (meta) => {
            meta.url = url.href;
        },
    });
    await main.link((specifier) => {
        const exports = dependencies[specifier];
        assert.ok(exports, specifier);
        return new SyntheticModule(
            Object.keys(exports),
            function () {
                for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
            },
            { context }
        );
    });
    let error: unknown;
    try {
        await main.evaluate();
    } catch (e) {
        error = e;
    }
    assert.equal(closed, file.startsWith("04") ? 2 : 1);
    return { logs, signed, prepared, quoted, error };
}

for (const file of ["01-prepare-and-broadcast.ts", "04-scheduled-cancel-recovery.ts"]) {
    test(`${file}: two 10-token Notes fund unchanged 10-token payment and bounded final fee`, async () => {
        const h = await fixture();
        const result = await runMain(file, h);
        assert.match(String(result.error), /STOP_BEFORE_SIGNING/);
        assert.equal(result.signed, 1);
        const snapshot = await h.store.readSnapshot(h.session.scope);
        const record = Object.values(snapshot.operations)[0]!;
        assert.equal(record.inputs.length, 2);
        const plan = (record.payload as any).plan;
        assert.equal(plan.params.feeAmount, unit / 10n);
        assert.equal(
            plan.params.feeRecipient.toLowerCase(),
            h.client.configuration.feeRecipient.toLowerCase()
        );
        const payment = plan.outputs.filter((o: any) => !o.change)[0].note;
        assert.equal(payment.amount, 10n * unit);
        assert.equal(payment.ownerAddress.toLowerCase(), h.bob.ownerAddress.toLowerCase());
        assert.equal(
            plan.outputs.reduce((n: bigint, o: any) => n + o.note.amount, 0n) +
                plan.params.feeAmount,
            20n * unit
        );
        assert.equal(record.status, "prepared");
        assert.ok(result.logs.some((line) => line[0] === "Operation ID:" && line[1] === record.id));
        if (file.startsWith("04")) {
            assert.ok(result.quoted.broadcasterScheduleHandle());
            assert.ok(
                (await h.session.resume(record.id)).broadcasterScheduleHandle(),
                "cancellation capability survives resume"
            );
        }
    });
    test(`${file}: excessive quoted fee rejects before wallet authorization`, async () => {
        const h = await fixture(2n * unit);
        const result = await runMain(file, h);
        assert.equal(result.signed, 0);
        assert.match(String(result.error), /fee.*(maximum|limit|exceed|cap)/i);
        const snapshot = await h.store.readSnapshot(h.session.scope);
        assert.equal(Object.values(snapshot.operations)[0]!.status, "prepared");
    });
}

test("real SDK refuses a prepared private fee budget beyond available inputs", async () => {
    const h = await fixture();
    const output = await NoteOutput.create({
        ...h.context,
        amount: 10n * unit,
        recipient: { type: "invisi", address: h.bob.getAddress() },
    });
    await assert.rejects(
        h.session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [output],
            fee: {
                recipient: h.client.configuration.feeRecipient as `0x${string}`,
                amount: 11n * unit,
            },
        }),
        /insufficient/i
    );
    assert.equal(Object.keys((await h.store.readSnapshot(h.session.scope)).operations).length, 0);
});

async function scheduledRecoveryFixture() {
    const h = await fixture();
    const base = h.client;
    const calls: { method: string; params: unknown }[] = [];
    const service = { lose: false, offline: false };
    h.client = new BroadcasterClient(base.configuration, async (request) => {
        calls.push({ method: request.method, params: structuredClone(request.params) });
        if (service.offline) throw Error("Relay offline");
        if (
            [
                "broadcaster_submitTransaction",
                "broadcaster_cancelTransaction",
                "broadcaster_getTransactionStatus",
            ].includes(request.method)
        ) {
            if (request.method === "broadcaster_submitTransaction" && service.lose) {
                service.lose = false;
                throw Error("Submission acknowledgement lost");
            }
            return {
                jsonrpc: "2.0",
                id: request.id,
                result: {
                    id: "saved-scheduled-job",
                    state:
                        request.method === "broadcaster_cancelTransaction"
                            ? "cancelled"
                            : "scheduled",
                    publishAfter: String(Math.floor(Date.now() / 1000) + 60),
                    executeBefore: String(Math.floor(Date.now() / 1000) + 360),
                },
            };
        }
        return base.transport(request);
    });
    const output = await NoteOutput.create({
        ...h.context,
        amount: 10n * unit,
        recipient: { type: "invisi", address: h.bob.getAddress() },
    });
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [output],
        fee: { recipient: h.client.configuration.feeRecipient as `0x${string}`, amount: unit },
        deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
    });
    const quoted = await h.client.quote(prepared, {
        maxFeeAmount: unit,
        schedule: { publishAfter: BigInt(Math.floor(Date.now() / 1000) + 60) },
    });
    const authorization = await quoted.exportWalletAuthorization();
    const { Wallet: EvmWallet } = await import("ethers");
    // The receiving-address fixture uses public test account scalar one.
    const signer = new EvmWallet("0x" + "1".padStart(64, "0"));
    const signature = await signer.signTypedData(
        authorization.domain,
        authorization.types,
        authorization.message
    );
    const ready = await (await quoted.withWalletSignature(signature)).prove();
    return { ...h, ready, calls, service };
}

test("scheduled example resumes the original ID keylessly and cancels without a status prerequisite", async () => {
    const h = await scheduledRecoveryFixture();
    await h.client.submit(h.ready);
    const before = h.calls.length;
    const result = await runMain("04-scheduled-cancel-recovery.ts", h, { operationId: h.ready.id });
    assert.equal(result.error, undefined);
    assert.equal(result.signed, 0);
    assert.equal(result.prepared, 0);
    assert.deepEqual(
        h.calls.slice(before).map((c) => c.method),
        ["broadcaster_cancelTransaction"]
    );
    const snapshot = await h.store.readSnapshot(h.session.scope);
    assert.equal(Object.keys(snapshot.operations).length, 1);
    assert.deepEqual(snapshot.reservations, {});
});

test("scheduled example replays an unknown acknowledgement only with an explicit recovery switch", async () => {
    const h = await scheduledRecoveryFixture();
    h.service.lose = true;
    await assert.rejects(h.client.submit(h.ready), /acknowledgement lost/);
    const before = h.calls.length;
    const refusal = await runMain("04-scheduled-cancel-recovery.ts", h, {
        operationId: h.ready.id,
    });
    assert.match(String(refusal.error), /recover-submit-id/);
    assert.equal(h.calls.length, before);
    assert.equal(Object.keys((await h.store.readSnapshot(h.session.scope)).reservations).length, 2);
    const result = await runMain("04-scheduled-cancel-recovery.ts", h, {
        operationId: h.ready.id,
        recoverSubmitId: true,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signed, 0);
    assert.equal(result.prepared, 0);
    const submissions = h.calls.filter((c) => c.method === "broadcaster_submitTransaction");
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[0]!.params, submissions[1]!.params);
    assert.equal(Object.keys((await h.store.readSnapshot(h.session.scope)).operations).length, 1);
});

test("scheduled example retries a journaled cancellation while the relay is offline", async () => {
    const h = await scheduledRecoveryFixture();
    await h.client.submit(h.ready);
    const getBlock = h.reader.getBlock;
    h.reader.getBlock = async () => {
        throw Error("Canonical RPC offline");
    };
    const failed = await runMain("04-scheduled-cancel-recovery.ts", h, { operationId: h.ready.id });
    assert.match(String(failed.error), /Canonical RPC offline/);
    assert.equal(Object.keys((await h.store.readSnapshot(h.session.scope)).reservations).length, 2);
    h.reader.getBlock = getBlock;
    h.service.offline = true;
    const before = h.calls.length;
    const result = await runMain("04-scheduled-cancel-recovery.ts", h, { operationId: h.ready.id });
    assert.equal(result.error, undefined);
    assert.equal(h.calls.length, before);
    assert.deepEqual((await h.store.readSnapshot(h.session.scope)).reservations, {});
    const repeated = await runMain("04-scheduled-cancel-recovery.ts", h, {
        operationId: h.ready.id,
    });
    assert.equal(repeated.error, undefined);
    assert.equal(h.calls.length, before);
});

test("scheduled recovery never submits an operation that was only quoted locally", async () => {
    const h = await scheduledRecoveryFixture();
    const before = h.calls.length;
    const result = await runMain("04-scheduled-cancel-recovery.ts", h, {
        operationId: h.ready.id,
        recoverSubmitId: true,
    });
    assert.match(String(result.error), /not been submitted|not attempted/i);
    assert.equal(h.calls.length, before);
    assert.equal(Object.keys((await h.store.readSnapshot(h.session.scope)).reservations).length, 2);
});

test("scheduled restart reopens a fresh session without a prover or account signer", async () => {
    const h = await scheduledRecoveryFixture();
    await h.client.submit(h.ready);
    const session = new WalletSession({
        invisi: new Invisi({ chainReader: h.reader, protocolRpc: h.membership }),
        wallet: h.wallet,
        protocol: h.protocol,
        store: h.store,
        namespace: "budget-test",
    });
    const before = h.calls.length;
    const result = await runMain(
        "04-scheduled-cancel-recovery.ts",
        { ...h, session },
        { operationId: h.ready.id }
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signed, 0);
    assert.equal(result.prepared, 0);
    assert.deepEqual(
        h.calls.slice(before).map((call) => call.method),
        ["broadcaster_cancelTransaction"]
    );
    assert.deepEqual((await h.store.readSnapshot(h.session.scope)).reservations, {});
});

test("scheduled restart in another wallet scope does not touch the original journal or relay", async () => {
    const h = await scheduledRecoveryFixture();
    await h.client.submit(h.ready);
    const session = new WalletSession({
        invisi: new Invisi({ chainReader: h.reader, protocolRpc: h.membership }),
        wallet: h.bob,
        protocol: h.protocol,
        store: h.store,
        namespace: "budget-test",
    });
    const before = await h.store.readSnapshot(h.session.scope);
    const calls = h.calls.length;
    const result = await runMain(
        "04-scheduled-cancel-recovery.ts",
        { ...h, session },
        { operationId: h.ready.id }
    );
    assert.match(String(result.error), /binding missing/);
    assert.equal(h.calls.length, calls);
    assert.deepEqual(await h.store.readSnapshot(h.session.scope), before);
});
