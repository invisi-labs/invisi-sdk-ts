import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import ts from "typescript";
import { keccak256 } from "ethers";
import { Invisi, NoteOutput, Protocol, Wallet } from "../../packages/sdk/dist/index.js";
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
        invisi: new Invisi({ chainReader: reader, protocolRpc: membership }),
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

async function runMain(file: string, h: Awaited<ReturnType<typeof fixture>>) {
    const logs: unknown[][] = [];
    let signed = 0,
        closed = 0,
        quoted: any;
    const quote = h.client.quote.bind(h.client);
    h.client.quote = async (...args: Parameters<typeof quote>) => {
        quoted = await quote(...args);
        return quoted;
    };
    const session = {
        refresh: async () => ({ decrypt: async () => {} }),
        balance: h.session.balance.bind(h.session),
        prepareTransfer: h.session.prepareTransfer.bind(h.session),
    };
    const protocol = {
        context: h.protocol.context,
        deployment: h.protocol.deployment,
        getBroadcasters: async () => [h.client],
    };
    class Empty {}
    class Provider {
        getNetwork = async () => ({ chainId: 97n });
        destroy() {
            closed++;
        }
    }
    class Signer {
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
        "@invisi-labs/session/sqlite": { SQLiteWalletStore: Empty },
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
        process: { argv: ["node", "example", "--execute"], env: {} },
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
    return { logs, signed, quoted, error };
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
