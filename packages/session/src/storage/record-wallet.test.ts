import { expect, it } from "vitest";
import { MemoryAtomicRecords, TransactionalWalletStore, initialState } from "./store";
import { MemoryRecordCodec } from "./codec";
import type { WalletScope } from "./state";
const scope: WalletScope = {
    namespace: "large",
    chainId: 97n,
    protocolAddress: `0x${"11".repeat(20)}`,
    ownerAddress: `0x${"22".repeat(20)}`,
};
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
it("archives terminal history and pages it without loading the lifetime wallet blob", async () => {
    const records = new MemoryAtomicRecords();
    const store = new TransactionalWalletStore(records, new MemoryRecordCodec(), {
        persistent: false,
        recentRecords: 2,
    });
    await store.transaction(scope, (draft) => {
        for (let n = 1; n <= 20; n++)
            draft.notes[hex(n)] = {
                note: {
                    chainId: scope.chainId,
                    protocolAddress: BigInt(scope.protocolAddress),
                    ownerAddress: scope.ownerAddress,
                    tokenAddress: 3n,
                    amount: 1n,
                    nonce: BigInt(n),
                },
                commitment: hex(n),
                treeId: 1n,
                leafIndex: n,
                blockNumber: BigInt(n),
                blockHash: hex(n),
                spent: n === 20 ? "unspent" : "spent",
            };
        draft.operations.pending = {
            id: "pending",
            inputs: [],
            status: "submitted",
            payload: { externalized: true },
        };
    });
    expect(Object.keys((await store.readSnapshot(scope)).notes)).toHaveLength(3);
    let cursor: string | undefined;
    const values: string[] = [];
    do {
        const page = await store.readRecords(scope, {
            kind: "notes",
            limit: 3,
            ...(cursor ? { cursor } : {}),
        });
        values.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
    } while (cursor);
    expect(values).toHaveLength(20);
    expect(new Set(values).size).toBe(20);
    expect((await store.readSnapshot(scope)).operations.pending?.status).toBe("submitted");
    const resumed = new TransactionalWalletStore(records, new MemoryRecordCodec(), {
        persistent: false,
        recentRecords: 2,
    });
    expect(
        (await resumed.readRecords(scope, { kind: "notes", limit: 2 })).items.map((item) => item.id)
    ).toEqual([hex(20), hex(19)]);
});
it("rejects stale history cursors instead of silently duplicating or skipping records", async () => {
    const store = new TransactionalWalletStore(new MemoryAtomicRecords(), new MemoryRecordCodec(), {
        persistent: false,
    });
    await store.transaction(scope, (draft) => {
        for (const id of ["a", "b", "c"])
            draft.operations[id] = { id, status: "prepared", inputs: [] };
    });
    const page = await store.readRecords(scope, { kind: "operations", limit: 1 });
    await store.transaction(scope, (draft) => {
        draft.operations.a!.status = "ready";
    });
    await expect(
        store.readRecords(scope, { kind: "operations", limit: 1, cursor: page.nextCursor! })
    ).rejects.toThrow(/changed/);
});

it("keeps large completed histories out of ordinary snapshots and encrypts only changed rows", async () => {
    let decoded = 0;
    const encodedSizes: number[] = [];
    class MeasuredCodec extends MemoryRecordCodec {
        override async decode(bytes: Uint8Array) {
            decoded++;
            return super.decode(bytes);
        }
        override async encode(state: import("./state").WalletState) {
            const bytes = await super.encode(state);
            encodedSizes.push(bytes.length);
            return bytes;
        }
    }
    const store = new TransactionalWalletStore(new MemoryAtomicRecords(), new MeasuredCodec(), {
        persistent: false,
        recentRecords: 3,
    });
    await store.transaction(scope, (draft) => {
        for (let n = 0; n < 1500; n++)
            draft.operations["old" + n] = {
                id: "old" + n,
                status: "failed",
                inputs: [],
                payload: { marker: "x".repeat(100) },
            };
    });
    decoded = 0;
    expect(Object.keys((await store.readSnapshot(scope)).operations)).toHaveLength(3);
    expect(decoded).toBeLessThan(10);
    decoded = 0;
    const page = await store.readRecords(scope, { kind: "operations", limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(decoded).toBe(6);
    encodedSizes.length = 0;
    await store.transaction(scope, (draft) => {
        draft.discoveryThrough = { number: 100n, hash: hex(100) };
    });
    expect(encodedSizes).toHaveLength(1);
    expect(encodedSizes[0]).toBeLessThan(2000);
});

it("migrates old blobs atomically and refuses to misread rows through a blob-only adapter", async () => {
    const { scopeKey } = await import("./store");
    const records = new MemoryAtomicRecords(),
        codec = new MemoryRecordCodec(),
        state = initialState(scope);
    state.revision = 1;
    state.operations.old = {
        id: "old",
        status: "submitted",
        inputs: [],
        payload: { externalized: true },
    };
    const data = await codec.encode(state);
    await records.compareAndSwap(scopeKey(scope), 0, { revision: 1, data });
    let fail = true;
    const wrapped = {
        read: records.read.bind(records),
        compareAndSwap: records.compareAndSwap.bind(records),
        readPage: records.readPage.bind(records),
        compareAndSwapBatch: async (...args: Parameters<typeof records.compareAndSwapBatch>) => {
            if (fail) throw Error("disk unavailable");
            return records.compareAndSwapBatch(...args);
        },
    };
    const store = new TransactionalWalletStore(wrapped, codec, { persistent: false });
    await expect(
        store.transaction(scope, (draft) => {
            draft.operations.old!.status = "uncertain";
        })
    ).rejects.toThrow("disk unavailable");
    expect((await records.read(scopeKey(scope)))?.data).toEqual(data);
    fail = false;
    await store.transaction(scope, (draft) => {
        draft.operations.old!.status = "uncertain";
    });
    expect((await store.readSnapshot(scope)).operations.old!.status).toBe("uncertain");
    const downgraded = new TransactionalWalletStore(
        { read: records.read.bind(records), compareAndSwap: records.compareAndSwap.bind(records) },
        codec,
        { persistent: false }
    );
    await expect(downgraded.readSnapshot(scope)).rejects.toThrow(/paged atomic/);
});

it("does not encode public commitment hashes or chain heights in encrypted row routing", async () => {
    const { scopeKey } = await import("./store");
    const { sha256 } = await import("@noble/hashes/sha256");
    const { bytesToHex, utf8ToBytes } = await import("@noble/hashes/utils");
    const routes: string[] = [];
    for (let i = 0; i < 2; i++) {
        const records = new MemoryAtomicRecords();
        const store = new TransactionalWalletStore(records, new MemoryRecordCodec(), {
            persistent: false,
        });
        await store.transaction(scope, (draft) => {
            draft.notes[hex(1)] = {
                note: {
                    chainId: scope.chainId,
                    protocolAddress: BigInt(scope.protocolAddress),
                    ownerAddress: scope.ownerAddress,
                    tokenAddress: 3n,
                    amount: 1n,
                    nonce: 1n,
                },
                commitment: hex(1),
                treeId: 1n,
                leafIndex: 0,
                blockNumber: 12n,
                blockHash: hex(12),
                spent: "unspent",
            };
        });
        const row = (
            await records.readPage(scopeKey(scope) + "/rows/active/notes/", undefined, 1)
        )[0]!;
        expect(row.key).not.toContain(bytesToHex(sha256(utf8ToBytes(hex(1)))));
        expect(row.key).not.toContain(((1n << 256n) - 1n - 12n).toString(16));
        routes.push(row.key);
    }
    expect(routes[0]).not.toBe(routes[1]);
});

it("keeps a terminal journal active while any reservation still references it", async () => {
    const store = new TransactionalWalletStore(new MemoryAtomicRecords(), new MemoryRecordCodec(), {
        persistent: false,
        recentRecords: 0,
    });
    await store.transaction(scope, (draft) => {
        draft.notes[hex(1)] = {
            note: {
                chainId: scope.chainId,
                protocolAddress: BigInt(scope.protocolAddress),
                ownerAddress: scope.ownerAddress,
                tokenAddress: 3n,
                amount: 1n,
                nonce: 1n,
            },
            commitment: hex(1),
            treeId: 1n,
            leafIndex: 0,
            blockNumber: 12n,
            blockHash: hex(12),
            spent: "spent",
        };
        draft.operations.op = { id: "op", status: "confirmed", inputs: [hex(1)] };
        draft.reservations[hex(1)] = "op";
    });
    expect((await store.readSnapshot(scope)).operations.op?.status).toBe("confirmed");
});
it("rejects missing or replayed active rows rather than reporting complete empty assets", async () => {
    const { scopeKey } = await import("./store");
    const records = new MemoryAtomicRecords();
    const store = new TransactionalWalletStore(records, new MemoryRecordCodec(), {
        persistent: false,
    });
    await store.transaction(scope, (draft) => {
        draft.notes[hex(1)] = {
            note: {
                chainId: scope.chainId,
                protocolAddress: BigInt(scope.protocolAddress),
                ownerAddress: scope.ownerAddress,
                tokenAddress: 3n,
                amount: 1n,
                nonce: 1n,
            },
            commitment: hex(1),
            treeId: 1n,
            leafIndex: 0,
            blockNumber: 12n,
            blockHash: hex(12),
            spent: "unspent",
        };
        draft.discoveryThrough = { number: 12n, hash: hex(12) };
    });
    const row = (await records.readPage(scopeKey(scope) + "/rows/active/notes/", undefined, 1))[0]!;
    await store.transaction(scope, (draft) => {
        draft.notes[hex(1)]!.spent = "unknown";
    });
    const guard = (await records.read(scopeKey(scope)))!;
    await records.compareAndSwapBatch(scopeKey(scope), guard.revision, guard, [
        { key: row.key, record: row },
    ]);
    await expect(store.readSnapshot(scope)).rejects.toThrow(/integrity/);
    await records.compareAndSwapBatch(scopeKey(scope), guard.revision, guard, [{ key: row.key }]);
    await expect(store.readSnapshot(scope)).rejects.toThrow(/integrity/);
    await expect(store.readSummary(scope)).rejects.toThrow(/integrity/);
});

it("does not expose or accept mutation of encrypted index internals in wallet snapshots", async () => {
    const store = new TransactionalWalletStore(new MemoryAtomicRecords(), new MemoryRecordCodec(), {
        persistent: false,
    });
    await store.transaction(scope, (draft) => {
        draft.operations.op = { id: "op", status: "submitted", inputs: [] };
    });
    expect(await store.readSnapshot(scope)).not.toHaveProperty("indexSalt");
    expect(await store.readSummary(scope)).not.toHaveProperty("indexSalt");
    await store.transaction(scope, (draft) => {
        (draft as unknown as { indexSalt: string }).indexSalt = "00".repeat(32);
    });
    expect((await store.readSnapshot(scope)).operations.op?.status).toBe("submitted");
});

it("rejects a custom codec that drops row metadata before publishing any wallet checkpoint", async () => {
    class DroppingCodec extends MemoryRecordCodec {
        override async encode(state: import("./state").WalletState) {
            const picked = {
                ...initialState(state.scope),
                revision: state.revision,
                notes: state.notes,
                credits: state.credits,
                operations: state.operations,
                reservations: state.reservations,
            };
            return super.encode(picked);
        }
    }
    const records = new MemoryAtomicRecords();
    const store = new TransactionalWalletStore(records, new DroppingCodec(), { persistent: false });
    await expect(
        store.transaction(scope, (draft) => {
            draft.operations.op = { id: "op", status: "submitted", inputs: [] };
        })
    ).rejects.toThrow(/codec.*metadata/);
    expect((await store.readSnapshot(scope)).operations).toEqual({});
});

it("rejects a codec that silently drops pending recovery metadata", async () => {
    class DroppingRecoveryCodec extends MemoryRecordCodec {
        override async encode(state: import("./state").WalletState) {
            const copy = { ...state };
            delete copy.creditReplayFrom;
            return super.encode(copy);
        }
    }
    const store = new TransactionalWalletStore(
        new MemoryAtomicRecords(),
        new DroppingRecoveryCodec(),
        { persistent: false }
    );
    await expect(
        store.transaction(scope, (draft) => {
            draft.creditReplayFrom = 100n;
        })
    ).rejects.toThrow(/codec.*metadata/);
});
