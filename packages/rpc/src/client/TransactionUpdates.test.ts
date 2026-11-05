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

describe("transaction updates", () => {
    it("preserves a stale indexed checkpoint for pending_index without weakening getStatus", async () => {
        const stale = { ...wireBlock, hash: h(99) };
        const { client } = setup((method) =>
            method === "invisi_getStatus"
                ? { ...status(), indexedHead: stale }
                : { ...transactionWire("pending_index"), indexedHead: stale }
        );
        await expect(client.getTransactionUpdates(context, h(123))).resolves.toMatchObject({
            status: "pending_index",
            indexedHead: { hash: h(99) },
            block: { hash: h(10) },
        });
        await expect(client.getStatus(context)).rejects.toThrow("canonical block mismatch");
    });

    it("preserves reverted indexed transactions and detects a reorg during a read", async () => {
        const { client, reader } = setup((method) =>
            method === "invisi_getStatus" ? status() : { ...transactionWire(), receiptStatus: 0 }
        );
        expect(await client.getTransactionUpdates(context, h(123))).toMatchObject({
            status: "indexed",
            receiptStatus: 0,
            outputs: [],
        });
        let reads = 0;
        reader.getBlock.mockImplementation(async () => ({
            ...block,
            hash: ++reads === 3 ? h(99) : block.hash,
        }));
        await expect(client.getTransactionUpdates(context, h(123))).rejects.toThrow(
            "changed during query"
        );
    });
    it("rejects conflicting duplicate Credit transitions", async () => {
        const event = {
            block: wireBlock,
            name: "CreditDraw",
            transactionHash: h(123),
            logIndex: 2,
            data: { amount: "10" },
        };
        const { client } = setup((method) =>
            method === "invisi_getStatus"
                ? status()
                : {
                      ...transactionWire(),
                      creditTransitions: [event, { ...event, data: { amount: "11" } }],
                  }
        );
        await expect(client.getTransactionUpdates(context, h(123))).rejects.toThrow(
            "Conflicting Credit transition"
        );
    });

    it.each(["not_found", "pending_index", "indexed"])("preserves %s state", async (state) => {
        const { client, requests } = setup((method) =>
            method === "invisi_getStatus" ? status() : transactionWire(state)
        );
        const result = await client.getTransactionUpdates(context, h(123));
        expect(result.status).toBe(state);
        expect(result.outputs).toEqual(state === "indexed" ? [] : null);
        expect(result.block).toEqual(state === "not_found" ? null : block);
        expect(requests.at(-1)).toMatchObject({
            method: "invisi_getTransactionUpdates",
            params: [h(123)],
        });
    });
    it("normalizes outputs and Credit transitions without extra range requests", async () => {
        const { client, requests } = setup((method) =>
            method === "invisi_getStatus"
                ? status()
                : {
                      ...transactionWire(),
                      outputs: [transactionOutput(), transactionOutput()],
                      creditTransitions: [
                          {
                              block: wireBlock,
                              name: "CreditDraw",
                              transactionHash: h(123),
                              logIndex: 2,
                              data: { amount: "10" },
                          },
                      ],
                  }
        );
        const result = await client.getTransactionUpdates(context, h(123));
        expect(result.status).toBe("indexed");
        if (result.status !== "indexed") throw new Error("Expected indexed result");
        expect(result.outputs).toHaveLength(1);
        expect(result.outputs[0]).toMatchObject({ treeId: 1n, block, transactionHash: h(123) });
        expect(result.creditTransitions[0]).toMatchObject({
            block,
            name: "CreditDraw",
            data: { amount: "10" },
        });
        expect(requests.map((r) => r.method)).toEqual([
            "invisi_getStatus",
            "invisi_getTransactionUpdates",
        ]);
    });
    it.each([
        { status: "unknown" },
        { transactionHash: h(9) },
        { blockHash: h(9) },
        { receiptStatus: 2 },
        { outputs: null },
        { indexedHead: null },
        { outputs: [{ ...transactionOutput(), transactionHash: h(99) }] },
        {
            outputs: [
                {
                    ...transactionOutput(),
                    block: { ...wireBlock, number: 9, hash: h(9), parentHash: h(8) },
                },
            ],
        },
        { outputs: [{ ...transactionOutput(), ciphertext: "0x" }] },
        {
            creditTransitions: [
                { block: wireBlock, name: "Other", transactionHash: h(123), logIndex: 1, data: {} },
            ],
        },
        {
            creditTransitions: [
                {
                    block: wireBlock,
                    name: "CreditDraw",
                    transactionHash: h(9),
                    logIndex: 1,
                    data: {},
                },
            ],
        },
        {
            creditTransitions: [
                {
                    block: { ...wireBlock, hash: h(9) },
                    name: "CreditDraw",
                    transactionHash: h(123),
                    logIndex: 1,
                    data: {},
                },
            ],
        },
        { status: "pending_index", outputs: [], creditTransitions: null },
        { status: "not_found", outputs: null, creditTransitions: null },
    ])("rejects inconsistent responses %j", async (patch) => {
        const { client } = setup((method) =>
            method === "invisi_getStatus" ? status() : { ...transactionWire(), ...patch }
        );
        await expect(client.getTransactionUpdates(context, h(123))).rejects.toBeInstanceOf(
            ProtocolRpcError
        );
    });
    it("rejects invalid hashes before network I/O and supports abort", async () => {
        const { client, requests } = setup(() => status());
        await expect(client.getTransactionUpdates(context, h(0))).rejects.toBeInstanceOf(
            ProtocolRpcError
        );
        await expect(client.getTransactionUpdates(context, "0x12")).rejects.toBeInstanceOf(
            ProtocolRpcError
        );
        expect(requests).toHaveLength(0);
        const controller = new AbortController();
        controller.abort();
        await expect(
            client.getTransactionUpdates(context, h(123), { signal: controller.signal })
        ).rejects.toMatchObject({ kind: "aborted" });
    });
});

it("preserves an empty Funds envelope in transaction updates", async () => {
    const output = { ...transactionOutput(), ciphertext: "0x", clue: "0x" };
    const { client } = setup((method) =>
        method === "invisi_getStatus" ? status() : { ...transactionWire(), outputs: [output] }
    );
    expect((await client.getTransactionUpdates(context, h(123))).outputs).toMatchObject([
        { leafIndex: 0, ciphertext: "0x", clue: "0x" },
    ]);
});
