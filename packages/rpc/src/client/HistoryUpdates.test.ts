import { expect, it } from "vitest";
import { setup, status, context, h } from "./ProtocolRpcClient-fixtures";
it("shares deployment status only within one combined public history page", async () => {
    const f = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : method === "invisi_getNoteUpdates"
              ? { blockHash: h(10), notes: [] }
              : []
    );
    const first = await f.client.getHistoryUpdates(context, { fromBlock: 1n, toBlock: 10n });
    expect(first.notes.notes).toEqual([]);
    expect(first.credits.transitions).toEqual([]);
    expect(f.requests.filter((r) => r.method === "invisi_getStatus")).toHaveLength(1);
    await f.client.getHistoryUpdates(context, { fromBlock: 1n, toBlock: 10n });
    expect(f.requests.filter((r) => r.method === "invisi_getStatus")).toHaveLength(2);
});
it("fails the combined history read if either stream has a different canonical anchor", async () => {
    const f = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : method === "invisi_getNoteUpdates"
              ? { blockHash: h(99), notes: [] }
              : []
    );
    await expect(
        f.client.getHistoryUpdates(context, { fromBlock: 1n, toBlock: 10n })
    ).rejects.toThrow("anchor mismatch");
});
it("rejects a reorg after stream acquisition instead of reusing its canonical fence", async () => {
    const f = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : method === "invisi_getNoteUpdates"
              ? { blockHash: h(10), notes: [] }
              : []
    );
    let calls = 0;
    f.reader.getBlock.mockImplementation(async () => ({
        number: 10n,
        hash: ++calls >= 3 ? h(999) : h(10),
        parentHash: h(9),
        timestamp: 123n,
    }));
    await expect(
        f.client.getHistoryUpdates(context, { fromBlock: 1n, toBlock: 10n })
    ).rejects.toThrow("block changed");
    expect(calls).toBeGreaterThanOrEqual(3);
});
it("rejects individually valid streams acquired from different canonical snapshots", async () => {
    const f = setup((method, params) =>
        method === "invisi_getStatus"
            ? status()
            : method === "invisi_getNoteUpdates"
              ? { blockHash: (params[0] as { blockHash: string }).blockHash, notes: [] }
              : []
    );
    let reads = 0;
    f.reader.getBlock.mockImplementation(async (number) => ({
        number,
        hash: ++reads % 2 ? h(9) : h(109),
        parentHash: h(8),
        timestamp: 123n,
    }));
    await expect(
        f.client.getHistoryUpdates(context, { fromBlock: 1n, toBlock: 9n })
    ).rejects.toThrow("history stream anchors differ");
});
