import { expect, it, vi } from "vitest";
import { MemoryAtomicRecords, MemoryRecordCodec, TransactionalWalletStore } from "../index";
import { fixture } from "../../../../test-support/operation-fixture";
import { testOutput } from "../../../../test-support/test-output";

it("reuses authenticated unchanged ciphertext and returns independent state copies", async () => {
    const h = await fixture(),
        records = new MemoryAtomicRecords(),
        codec = new MemoryRecordCodec();
    const decode = vi.spyOn(codec, "decode");
    const store = new TransactionalWalletStore(records, codec, { persistent: false });
    const seed = await h.store.readSnapshot(h.scope);
    await store.transaction(h.scope, (state) => {
        state.notes = structuredClone(seed.notes);
    });
    const one = await store.readSnapshot(h.scope),
        count = decode.mock.calls.length;
    one.notes[h.leaf]!.note.amount = 1n;
    const two = await store.readSnapshot(h.scope);
    expect(two.notes[h.leaf]!.note.amount).toBe(100n);
    expect(decode.mock.calls.length).toBe(count);
});

it("does not turn read-only signing freshness checks into writes", async () => {
    const h = await fixture();
    const op = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [await testOutput(h, { to: h.bob.getAddress(), amount: 30n })],
    });
    const transaction = vi.spyOn(h.store, "transaction");
    const before = (await h.store.readSnapshot(h.scope)).revision;
    await op.exportWalletAuthorization();
    expect(transaction).not.toHaveBeenCalled();
    expect((await h.store.readSnapshot(h.scope)).revision).toBe(before);
});

it("observes writes from another store instance instead of reusing an old decoded row", async () => {
    const h = await fixture(),
        records = new MemoryAtomicRecords();
    const first = new TransactionalWalletStore(records, new MemoryRecordCodec(), {
        persistent: false,
    });
    const second = new TransactionalWalletStore(records, new MemoryRecordCodec(), {
        persistent: false,
    });
    const seed = await h.store.readSnapshot(h.scope);
    await first.transaction(h.scope, (state) => {
        state.notes = structuredClone(seed.notes);
    });
    expect((await first.readSnapshot(h.scope)).notes[h.leaf]!.note.amount).toBe(100n);
    await second.transaction(h.scope, (state) => {
        state.notes[h.leaf]!.note.amount = 200n;
    });
    expect((await first.readSnapshot(h.scope)).notes[h.leaf]!.note.amount).toBe(200n);
});

it("does not reuse a cached decode when ciphertext changes at the same key and revision", async () => {
    const { DecodedRecordCache } = await import("./decoded-cache");
    const h = await fixture(),
        codec = new MemoryRecordCodec(),
        cache = new DecodedRecordCache(codec);
    const state = await h.store.readSnapshot(h.scope),
        bytes = await codec.encode(state),
        context = { key: "test", revision: 1 };
    const decode = vi.spyOn(codec, "decode");
    await cache.decode(bytes, context);
    const corrupt = bytes.slice();
    corrupt[0] = 0;
    await expect(cache.decode(corrupt, context)).rejects.toThrow();
    await cache.decode(bytes, context);
    expect(decode).toHaveBeenCalledTimes(2);
});

it("bounds decoded row retention", async () => {
    const { DecodedRecordCache } = await import("./decoded-cache");
    const h = await fixture(),
        codec = new MemoryRecordCodec(),
        cache = new DecodedRecordCache(codec);
    const bytes = await codec.encode(await h.store.readSnapshot(h.scope)),
        decode = vi.spyOn(codec, "decode");
    for (let index = 0; index < 513; index++)
        await cache.decode(bytes, { key: String(index), revision: 1 });
    const count = decode.mock.calls.length;
    await cache.decode(bytes, { key: "0", revision: 1 });
    expect(decode.mock.calls.length).toBe(count + 1);
});

it("authenticates cold data again in a new store instance", async () => {
    const h = await fixture(),
        records = new MemoryAtomicRecords();
    const writer = new TransactionalWalletStore(records, new MemoryRecordCodec(), {
        persistent: false,
    });
    const seed = await h.store.readSnapshot(h.scope);
    await writer.transaction(h.scope, (state) => {
        state.notes = structuredClone(seed.notes);
    });
    const codec = new MemoryRecordCodec(),
        decode = vi.spyOn(codec, "decode");
    const reader = new TransactionalWalletStore(records, codec, { persistent: false });
    decode.mockRejectedValueOnce(Error("locked"));
    await expect(reader.readSnapshot(h.scope)).rejects.toThrow("locked");
    await reader.readSnapshot(h.scope);
    const calls = decode.mock.calls.length;
    expect(calls).toBeGreaterThan(1);
    await reader.readSnapshot(h.scope);
    expect(decode.mock.calls.length).toBe(calls);
});

it("owns ciphertext bytes across asynchronous codec calls", async () => {
    const { DecodedRecordCache } = await import("./decoded-cache");
    const h = await fixture(),
        codec = new MemoryRecordCodec();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const cache = new DecodedRecordCache({
        encode: (value) => codec.encode(value),
        decode: async (bytes) => {
            await gate;
            return codec.decode(bytes);
        },
    });
    const bytes = await codec.encode(await h.store.readSnapshot(h.scope));
    const pending = cache.decode(bytes, { key: "owned", revision: 1 });
    bytes.fill(0);
    release();
    expect((await pending).notes[h.leaf]!.note.amount).toBe(100n);
});
