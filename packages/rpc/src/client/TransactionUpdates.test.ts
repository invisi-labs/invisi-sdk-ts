import { describe, expect, it } from "vitest";
import { ProtocolRpcError } from "./ProtocolRpcClient";
import {
    block,
    context,
    h,
    setup,
    status,
    transactionOutput,
    transactionWire,
    wireBlock,
} from "./ProtocolRpcClient-fixtures";

const transition = () => ({
    block: wireBlock,
    name: "CreditStateTransition",
    transactionHash: h(123),
    logIndex: 2,
    data: { totalAmount: "10" },
});
describe.each([false, true])("typed transaction credit=%s", (credit) => {
    const method = credit ? "getTransactionCreditUpdates" : "getTransactionNoteUpdates";
    const route = credit
        ? "invisi_getTransactionCreditUpdates"
        : "invisi_getTransactionNoteUpdates";
    it.each(["not_found", "pending_index", "indexed"])(
        "preserves availability %s",
        async (state) => {
            const { client, requests } = setup((m) =>
                m === "invisi_getStatus" ? status() : transactionWire(state)
            );
            const r = await client[method](context, h(123));
            expect(r.status).toBe(state);
            expect(r.block).toEqual(state === "not_found" ? null : block);
            expect(requests.at(-1)).toMatchObject({ method: route, params: [h(123)] });
            if (credit) expect("notes" in r).toBe(false);
            else expect("states" in r).toBe(false);
        }
    );
    it.each([
        { status: "unknown" },
        { transactionHash: h(9) },
        { blockHash: h(9) },
        { receiptStatus: 2 },
        { indexedHead: null },
        { status: "pending_index", notes: [], states: [], transitions: null },
        { status: "not_found" },
    ])("rejects inconsistent availability %j", async (patch) => {
        const { client } = setup((m) =>
            m === "invisi_getStatus" ? status() : { ...transactionWire(), ...patch }
        );
        await expect(client[method](context, h(123))).rejects.toBeInstanceOf(ProtocolRpcError);
    });
    it("preserves stale pending head without trusting it as canonical", async () => {
        const stale = { ...wireBlock, hash: h(99) };
        const { client } = setup((m) =>
            m === "invisi_getStatus"
                ? { ...status(), indexedHead: stale }
                : { ...transactionWire("pending_index"), indexedHead: stale }
        );
        expect(await client[method](context, h(123))).toMatchObject({
            status: "pending_index",
            indexedHead: { hash: h(99) },
        });
        await expect(client.getStatus(context)).rejects.toThrow("canonical block mismatch");
    });
    it("detects query reorganization", async () => {
        const { client, reader } = setup((m) =>
            m === "invisi_getStatus" ? status() : transactionWire()
        );
        let count = 0;
        reader.getBlock.mockImplementation(async () => ({
            ...block,
            hash: ++count === 3 ? h(99) : block.hash,
        }));
        await expect(client[method](context, h(123))).rejects.toThrow("changed during query");
    });
    it("rejects invalid hashes and handles abort", async () => {
        const { client, requests } = setup(() => status());
        await expect(client[method](context, h(0))).rejects.toThrow();
        await expect(client[method](context, "0x12")).rejects.toThrow();
        expect(requests).toHaveLength(0);
        const controller = new AbortController();
        controller.abort();
        await expect(
            client[method](context, h(123), { signal: controller.signal })
        ).rejects.toMatchObject({ kind: "aborted" });
    });
});
it("normalizes ordinary transaction Notes without mixed Credit collections", async () => {
    const { client } = setup((m) =>
        m === "invisi_getStatus"
            ? status()
            : { ...transactionWire(), notes: [transactionOutput(), transactionOutput()] }
    );
    const r = await client.getTransactionNoteUpdates(context, h(123));
    expect(r.status).toBe("indexed");
    if (r.status !== "indexed") throw new Error("indexed required");
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatchObject({ treeId: 1n, block });
    expect("transitions" in r).toBe(false);
});
it("preserves omitted Note envelopes", async () => {
    const { client } = setup((m) =>
        m === "invisi_getStatus"
            ? status()
            : {
                  ...transactionWire(),
                  notes: [{ ...transactionOutput(), ciphertext: "0x", clue: "0x" }],
              }
    );
    expect((await client.getTransactionNoteUpdates(context, h(123))).notes).toMatchObject([
        { ciphertext: "0x", clue: "0x" },
    ]);
});
it.each([false, true])(
    "rejects cross-transaction and reverted updates credit=%s",
    async (credit) => {
        const { client } = setup((m) =>
            m === "invisi_getStatus"
                ? status()
                : {
                      ...transactionWire(),
                      notes: [{ ...transactionOutput(), transactionHash: h(9) }],
                      transitions: [{ ...transition(), transactionHash: h(9) }],
                  }
        );
        await expect(
            credit
                ? client.getTransactionCreditUpdates(context, h(123))
                : client.getTransactionNoteUpdates(context, h(123))
        ).rejects.toThrow("different transaction");
    }
);
it("validates Credit transition identity and duplicates independently", async () => {
    const event = transition();
    const { client } = setup((m) =>
        m === "invisi_getStatus"
            ? status()
            : {
                  ...transactionWire(),
                  transitions: [event, { ...event, data: { totalAmount: "11" } }],
              }
    );
    await expect(client.getTransactionCreditUpdates(context, h(123))).rejects.toThrow(
        "Conflicting Credit transition"
    );
});
it.each(["Transact", "UnknownEvent"])(
    "rejects non-Credit or unknown transition %s",
    async (name) => {
        const { client } = setup((m) =>
            m === "invisi_getStatus"
                ? status()
                : { ...transactionWire(), transitions: [{ ...transition(), name }] }
        );
        await expect(client.getTransactionCreditUpdates(context, h(123))).rejects.toThrow(
            "Invalid Credit transition"
        );
    }
);
