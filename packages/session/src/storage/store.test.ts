import { fundsV1 } from "@invisi-labs/primitives";
import { expect, it } from "vitest";
import vectors from "../../../primitives/src/wallet/testdata/wallet-note-vectors.json";
import {
    MemoryAtomicRecords,
    MemoryRecordCodec,
    MemoryWalletStore,
    TransactionalWalletStore,
    initialState,
    mergeReceiptRecords,
    releaseInputs,
    reserveInputs,
    scopeKey,
    walletBalance,
    type WalletScope,
} from "../index";
const scope: WalletScope = {
    namespace: "alice",
    chainId: 31337n,
    protocolAddress: "0x1111111111111111111111111111111111111111",
    ownerAddress: ("0x" + "01".padStart(40, "0")) as `0x${string}`,
};
const leaf = (n: number) => ("0x" + n.toString(16).padStart(64, "0")) as `0x${string}`;
const input = (amount = 100n) => ({
    note: {
        chainId: scope.chainId,
        protocolAddress: BigInt(scope.protocolAddress),
        ownerAddress: scope.ownerAddress,
        tokenAddress: 0x2222222222222222222222222222222222222222n,
        amount,
        nonce: 1n,
    },
    commitment: leaf(1),
    treeId: 1n,
    leafIndex: 0,
    blockNumber: 12n,
    blockHash: leaf(12),
    spent: "unspent" as const,
});
it("commits state and checkpoint atomically, rolls back exceptions, and returns owned snapshots", async () => {
    const store = new MemoryWalletStore();
    await expect(
        store.transaction(scope, (draft) => {
            draft.notes[leaf(1)] = input();
            draft.observedThrough = { number: 12n, hash: leaf(12) };
            throw new Error("abort");
        })
    ).rejects.toThrow("abort");
    expect((await store.readSnapshot(scope)).notes).toEqual({});
    await store.transaction(scope, (draft) => {
        draft.notes[leaf(1)] = input();
        draft.observedThrough = { number: 12n, hash: leaf(12) };
    });
    const snapshot = await store.readSnapshot(scope);
    snapshot.notes[leaf(1)]!.note.amount = 1n;
    expect((await store.readSnapshot(scope)).notes[leaf(1)]!.note.amount).toBe(100n);
    await expect(store.transaction(scope, async () => 1)).rejects.toThrow(/synchronous/i);
});
it("atomically reserves overlapping inputs across sessions and retains uncertain locks", async () => {
    const store = new MemoryWalletStore();
    await store.transaction(scope, (draft) => {
        draft.notes[leaf(1)] = input();
    });
    const attempts = await Promise.allSettled([
        reserveInputs(store, scope, "operation-a", [leaf(1)]),
        reserveInputs(store, scope, "operation-b", [leaf(1)]),
    ]);
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const state = await store.readSnapshot(scope),
        operation = state.reservations[leaf(1)]!;
    expect(walletBalance(state, "0x2222222222222222222222222222222222222222")).toMatchObject({
        confirmedKnown: 100n,
        reserved: 100n,
        availableKnown: 0n,
    });
    await store.transaction(scope, (draft) => {
        draft.operations[operation]!.status = "uncertain";
    });
    await expect(releaseInputs(store, scope, operation)).rejects.toThrow(/submitted|uncertain/i);
    expect((await store.readSnapshot(scope)).reservations[leaf(1)]).toBe(operation);
});
it("isolates tenants and deployments and treats unknown spent state conservatively", async () => {
    const store = new MemoryWalletStore();
    await store.transaction(scope, (draft) => {
        draft.notes[leaf(1)] = { ...input(), spent: "unknown" };
        draft.observedThrough = { number: 20n, hash: leaf(20) };
    });
    expect(
        walletBalance(await store.readSnapshot(scope), "0x2222222222222222222222222222222222222222")
    ).toMatchObject({
        availableKnown: null,
    });
    await expect(reserveInputs(store, scope, "no-spent-permission", [leaf(1)])).rejects.toThrow(
        /unknown|unavailable/i
    );
    for (const other of [
        { ...scope, namespace: "bob" },
        { ...scope, chainId: 1n },
        { ...scope, protocolAddress: "0x3333333333333333333333333333333333333333" as const },
    ])
        expect((await store.readSnapshot(other)).notes).toEqual({});
});
it("rejects async mutation before running it and never stores half a checkpoint", async () => {
    const store = new MemoryWalletStore();
    let ran = false;
    await expect(
        store.transaction(scope, async (draft) => {
            ran = true;
            draft.observedThrough = { number: 999n, hash: leaf(999) };
            throw new Error("async must not run");
        })
    ).rejects.toThrow(/synchronous/i);
    expect(ran).toBe(false);
    expect((await store.readSnapshot(scope)).observedThrough).toBeUndefined();
});
it("applies repeated canonical receipts idempotently and rolls back position conflicts", async () => {
    const store = new MemoryWalletStore(),
        batch = {
            notes: [input()],
            credits: [],
            checkpoint: { number: 12n, hash: leaf(12) },
        };
    await store.transaction(scope, (state) => mergeReceiptRecords(state, batch));
    await store.transaction(scope, (state) => mergeReceiptRecords(state, batch));
    expect(Object.keys((await store.readSnapshot(scope)).notes)).toHaveLength(1);
    await expect(
        store.transaction(scope, (state) =>
            mergeReceiptRecords(state, {
                ...batch,
                notes: [{ ...input(), commitment: leaf(2) }],
                checkpoint: { number: 13n, hash: leaf(13) },
            })
        )
    ).rejects.toThrow(/position|canonical/i);
    expect((await store.readSnapshot(scope)).observedThrough).toBeUndefined();
});
it("does not expose tenant names or wallet identities in persistent record keys", () => {
    const key = scopeKey(scope);
    expect(key).not.toContain(scope.namespace);
    expect(key).not.toContain(scope.ownerAddress);
    expect(
        scopeKey({
            ...scope,
            protocolAddress: scope.protocolAddress
                .toUpperCase()
                .replace("0X", "0x") as `0x${string}`,
        })
    ).toBe(key);
});
it("does not corrupt persistent revision state when its counter is exhausted", async () => {
    const records = new MemoryAtomicRecords(),
        codec = new MemoryRecordCodec(),
        state = initialState(scope),
        key = scopeKey(scope);
    state.revision = Number.MAX_SAFE_INTEGER;
    await records.compareAndSwap(key, 0, {
        revision: state.revision,
        data: await codec.encode(state),
    });
    const store = new TransactionalWalletStore(records, codec, { persistent: false });
    await expect(store.transaction(scope, () => undefined)).rejects.toThrow(/revision/i);
    expect((await store.readSnapshot(scope)).revision).toBe(Number.MAX_SAFE_INTEGER);
});
it("reports spent-state checkpoint separately from observed receipt checkpoints and does not claim an unscanned wallet is empty", async () => {
    const store = new MemoryWalletStore(),
        empty = await store.readSnapshot(scope);
    expect(walletBalance(empty, "0x2222222222222222222222222222222222222222")).toMatchObject({
        availableKnown: null,
        checkedThrough: null,
        scope,
    });
    await store.transaction(scope, (draft) => {
        draft.notes[leaf(1)] = { ...input(), checkedThrough: { number: 15n, hash: leaf(15) } };
        draft.observedThrough = { number: 12n, hash: leaf(12) };
    });
    expect(
        walletBalance(await store.readSnapshot(scope), "0x2222222222222222222222222222222222222222")
    ).toMatchObject({
        availableKnown: 100n,
        checkedThrough: { number: 15n, hash: leaf(15) },
    });
});

it("merges fresh spent observations for duplicate notes without regressing newer facts", async () => {
    const store = new MemoryWalletStore(),
        batch = {
            notes: [{ ...input(), checkedThrough: { number: 13n, hash: leaf(13) } }],
            credits: [],
            checkpoint: { number: 12n, hash: leaf(12) },
        };
    await store.transaction(scope, (state) => mergeReceiptRecords(state, batch));
    await store.transaction(scope, (state) =>
        mergeReceiptRecords(state, {
            ...batch,
            notes: [
                { ...input(), spent: "spent", checkedThrough: { number: 20n, hash: leaf(20) } },
            ],
        })
    );
    await store.transaction(scope, (state) => mergeReceiptRecords(state, batch));
    const state = await store.readSnapshot(scope);
    expect(walletBalance(state, "0x2222222222222222222222222222222222222222").availableKnown).toBe(
        0n
    );
    expect(state.notes[leaf(1)]!.checkedThrough!.number).toBe(20n);
});

it("reloads raw encrypted memo metadata through the record codec without aliasing", async () => {
    const records = new MemoryAtomicRecords();
    const codec = new MemoryRecordCodec();
    const store = new TransactionalWalletStore(records, codec, { persistent: false });
    const memo = new Uint8Array([0, 255, 192, 128]);
    await store.transaction(scope, (draft) => {
        const record = input();
        draft.notes[leaf(1)] = {
            ...record,
            note: { ...record.note, payload: fundsV1.encode({ memo }) },
        };
        const keys = (role: "owner" | "spender") => ({
            viewingPublicKey: Uint8Array.from(
                Buffer.from(
                    vectors.credit[
                        role === "owner" ? "ownerReceivingKeys" : "spenderReceivingKeys"
                    ].viewingPublicKey.slice(2),
                    "hex"
                )
            ),
            clueKey: Uint8Array.from(
                Buffer.from(
                    vectors.credit[
                        role === "owner" ? "ownerReceivingKeys" : "spenderReceivingKeys"
                    ].clueKey.slice(2),
                    "hex"
                )
            ),
        });
        draft.credits[leaf(2) + ":owner"] = {
            ...record,
            commitment: leaf(2),
            leafIndex: 1,
            role: "owner",
            state: {
                note: {
                    chainId: scope.chainId,
                    protocolAddress: BigInt(scope.protocolAddress),
                    tokenAddress: record.note.tokenAddress,
                    ownerWalletIdentity: scope.ownerAddress,
                    spenderWalletIdentity: scope.ownerAddress,
                    revocationShard: 1n,
                    revocationSlot: 0n,
                    nonce: 2n,
                    expiry: 2000000000n,
                    creditSharedKey: 3n,
                    availableCredit: 10n,
                    unlimited: false,
                    payload: fundsV1.encode({ memo }),
                },
                ownerReceivingKeys: keys("owner"),
                spenderReceivingKeys: keys("spender"),
            },
        };
    });
    memo.fill(7);
    const reloaded = new TransactionalWalletStore(records, codec, { persistent: false });
    const snapshot = await reloaded.readSnapshot(scope);
    expect(fundsV1.decode(snapshot.notes[leaf(1)]!.note.payload!).memo).toEqual(
        new Uint8Array([0, 255, 192, 128])
    );
    expect(fundsV1.decode(snapshot.credits[leaf(2) + ":owner"]!.state.note.payload!).memo).toEqual(
        new Uint8Array([0, 255, 192, 128])
    );
    (fundsV1.decode(snapshot.notes[leaf(1)]!.note.payload!).memo as Uint8Array).fill(8);
    (
        fundsV1.decode(snapshot.credits[leaf(2) + ":owner"]!.state.note.payload!).memo as Uint8Array
    ).fill(8);
    expect(
        fundsV1.decode(
            (await reloaded.readSnapshot(scope)).credits[leaf(2) + ":owner"]!.state.note.payload!
        ).memo
    ).toEqual(new Uint8Array([0, 255, 192, 128]));
    expect(
        fundsV1.decode((await reloaded.readSnapshot(scope)).notes[leaf(1)]!.note.payload!).memo
    ).toEqual(new Uint8Array([0, 255, 192, 128]));
});
