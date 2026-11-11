import { refreshSession } from "../../../../test-support/native-wallet";
import { Wallet } from "@invisi-labs/primitives";
import { Invisi } from "@invisi-labs/sdk/session-support";
import { expect, it, vi } from "vitest";
import { canonicalBlock, fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { testOutput } from "../../../../test-support/test-output";
import { WalletSession } from "../wallet/WalletSession";

it("restores private outgoing history without exposing execution witnesses", async () => {
    const h = await fixture();
    const payload = new Uint8Array([1, 42]);
    const operation = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n, payload })],
    });
    const restored = new WalletSession(sessionOptions(h.options));
    const history = await restored.getHistory();
    const outgoing = history.outgoing.find((entry) => entry.id === operation.id)!;
    expect(outgoing.status).toBe("prepared");
    expect(outgoing.outputs.map((output) => output.amount)).toEqual([30n, 70n]);
    expect(outgoing.outputs[0]!.payload).toEqual(payload);
    expect(outgoing).not.toHaveProperty("plan");
    expect(outgoing).not.toHaveProperty("statement");
    outgoing.outputs[0]!.payload.fill(0);
    expect((await restored.getHistory()).outgoing[0]!.outputs[0]!.payload).toEqual(payload);
    await operation.abandon();
    expect((await restored.getHistory()).outgoing[0]!.status).toBe("failed");
});

it("keeps spent incoming notes and supports token-filtered history", async () => {
    const h = await fixture();
    await h.store.transaction(h.scope, (state) => {
        state.notes[h.leaf]!.spent = "spent";
    });
    const history = await h.session.getHistory({ tokenAddress: h.context.tokenAddress });
    expect(history.incoming).toHaveLength(1);
    expect(history.incoming[0]!.spent).toBe("spent");
    expect(history.incoming[0]!.amount).toBe(100n);
    expect(
        (await h.session.getHistory({ tokenAddress: "0x3333333333333333333333333333333333333333" }))
            .incoming
    ).toEqual([]);
});

it("notifies after local commits and isolates observer errors", async () => {
    const h = await fixture();
    const listener = vi.fn();
    const stop = h.session.subscribe(listener);
    h.session.subscribe(() => {
        throw new Error("UI failed");
    });
    const operation = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    expect(listener).toHaveBeenCalled();
    expect((await h.session.getHistory()).outgoing[0]!.id).toBe(operation.id);
    stop();
    listener.mockClear();
    await operation.abandon();
    expect(listener).not.toHaveBeenCalled();
});

it("connects explicit session signers without enabling infrastructure signer defaults", async () => {
    const h = await fixture();
    const signer = { provider: null };
    const invisi = new Invisi({ chainReader: h.reader });
    const session = await WalletSession.connect({
        invisi,
        store: h.store,
        wallet: Wallet.fromAddress(h.wallet.getAddress()),

        protocol: h.protocol,
        signer: signer as never,
    });
    await expect(
        session.sendTransaction(
            { to: h.context.protocolAddress, data: "0x", value: 0n },
            { gasLimit: 100000n }
        )
    ).rejects.toThrow(/connected ethers signer/);
    expect(() => new Invisi({ signer } as never)).toThrow(/signer/);
});

it("does not notify failed writes or read-only queries", async () => {
    const h = await fixture();
    const session = new WalletSession(
        sessionOptions({
            ...h.options,
            store: {
                persistent: true,
                readSnapshot: (scope) => h.store.readSnapshot(scope),
                transaction: async () => {
                    throw new Error("disk unavailable");
                },
            },
        })
    );
    const listener = vi.fn();
    session.subscribe(listener);
    await session.getHistory();
    await expect(
        session.prepareTransfer({
            tokenAddress: h.context.tokenAddress,
            outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
        })
    ).rejects.toThrow(/disk unavailable/);
    expect(listener).not.toHaveBeenCalled();
});

it("restores history and reservations through a newly opened encrypted store", async () => {
    const h = await fixture();
    const { TransactionalWalletStore, MemoryAtomicRecords } = await import("../storage/store");
    const { EncryptedWalletCodec } = await import("../storage/encrypted-codec");
    const records = new MemoryAtomicRecords();
    const key = new Uint8Array(32).fill(77);
    const first = new TransactionalWalletStore(records, await EncryptedWalletCodec.fromBytes(key), {
        persistent: true,
    });
    const inventory = await h.store.readSnapshot(h.scope);
    await first.transaction(h.scope, (draft) => {
        draft.notes = inventory.notes;
        draft.observedThrough = inventory.observedThrough!;
    });
    const session = new WalletSession(sessionOptions({ ...h.options, store: first }));
    const operation = await session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [
            await testOutput(h, {
                to: h.bob.getAddress(),
                amount: 30n,
                payload: new Uint8Array([9]),
            }),
        ],
    });
    const reopened = new TransactionalWalletStore(
        records,
        await EncryptedWalletCodec.fromBytes(key),
        { persistent: true }
    );
    const restored = new WalletSession(sessionOptions({ ...h.options, store: reopened }));
    expect((await restored.getHistory()).outgoing[0]!.id).toBe(operation.id);
    expect((await restored.getHistory()).outgoing[0]!.outputs[0]!.payload).toEqual(
        new Uint8Array([9])
    );
    expect((await restored.balance(h.context.tokenAddress)).reserved).toBe(100n);
    const recovered = await restored.resume(operation.id);
    await recovered.abandon();
    expect((await restored.balance(h.context.tokenAddress)).reserved).toBe(0n);
    expect((await restored.getHistory()).outgoing[0]!.status).toBe("failed");
});

it("does not confuse chain observations with successfully scanned history ranges", async () => {
    const h = await fixture();
    vi.spyOn(h.reader, "getBlock").mockImplementation(async (n) => canonicalBlock(n));
    expect((await h.session.getHistory()).checkedThrough).toBeNull();
    await refreshSession(h.session, { fromBlock: 0n, toBlock: 12n });
    expect((await h.session.getHistory()).checkedThrough?.number).toBe(12n);
    await h.store.transaction(h.scope, (state) => {
        state.observedThrough = { number: 100n, hash: state.observedThrough!.hash };
    });
    expect((await h.session.getHistory()).checkedThrough?.number).toBe(12n);
});

it("recovers only missing coverage without rescanning previously committed ranges", async () => {
    const h = await fixture();
    vi.spyOn(h.reader, "getBlock").mockImplementation(async (n) => canonicalBlock(n));
    await refreshSession(h.session, { fromBlock: 1n, toBlock: 12n });
    expect((await h.session.getHistory()).checkedThrough).toBeNull();
    vi.spyOn(h.membership, "getCreditTransitions").mockImplementation(async (_, range) => ({
        block: { ...(await h.reader.getBlock(range.toBlock)), number: range.toBlock },
        transitions: [],
    }));
    let pages = 0;
    vi.spyOn(h.membership, "getNoteUpdates").mockImplementation(async (_, range) => {
        if (++pages === 2) throw new Error("indexer unavailable");
        const block = { ...(await h.reader.getBlock(range.toBlock)), number: range.toBlock };
        return { block, notes: [] };
    });
    await refreshSession(new WalletSession(sessionOptions(h.options)), {
        fromBlock: 0n,
        toBlock: 12n,
        pageSize: 5,
    });
    expect(pages).toBe(1);
    expect((await h.session.getHistory()).checkedThrough?.number).toBe(12n);
});
