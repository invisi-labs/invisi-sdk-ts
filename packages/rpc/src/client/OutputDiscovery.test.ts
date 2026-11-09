import { expect, it } from "vitest";
import { ProtocolRpcError } from "./ProtocolRpcClient";
import {
    block,
    context,
    encryptedOutput,
    h,
    setup,
    status,
    wireBlock,
} from "./ProtocolRpcClient-fixtures";

it("returns canonical encrypted output fields without fetching receipts", async () => {
    const { client, requests } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  notes: [encryptedOutput()],
                  creditTransitions: [],
              }
    );
    const result = await client.getNoteUpdates(context, { fromBlock: 10n, toBlock: 10n });
    expect(result.notes[0]).toMatchObject({
        treeId: 1n,
        leafIndex: 3,
        commitment: h(12),
        ciphertext: encryptedOutput().ciphertext,
        block,
    });
    expect(requests.map((r) => r.method)).toEqual(["invisi_getStatus", "invisi_getNoteUpdates"]);
});

it.each([
    { treeId: "0" },
    { leafIndex: 65536 },
    { token: "invalid" },
    { ciphertext: "0x" },
    { ciphertext: "0x" + "00".repeat(4097) },
    { clue: "0x12" },
    { clue: "0x" },
    { commitment: h(1n << 255n) },
    { transactionHash: "0x12" },
    { kind: "" },
    { block: { ...wireBlock, number: 9, hash: h(9), parentHash: h(8) } },
])("rejects malformed indexed outputs %j", async (patch) => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  notes: [{ ...encryptedOutput(), ...patch }],
                  creditTransitions: [],
              }
    );
    await expect(
        client.getNoteUpdates(context, { fromBlock: 10n, toBlock: 10n })
    ).rejects.toBeInstanceOf(ProtocolRpcError);
});

it("ignores identical indexed outputs", async () => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  notes: [encryptedOutput(), encryptedOutput()],
                  creditTransitions: [],
              }
    );
    expect(
        (await client.getNoteUpdates(context, { fromBlock: 10n, toBlock: 10n })).notes
    ).toHaveLength(1);
});

it.each([true, false, "false"])("validates indexed spent observations %j", async (value) => {
    const { client } = setup(() => value);
    if (typeof value === "boolean")
        expect(await client.isNoteSpent(context, h(1), block)).toBe(value);
    else await expect(client.isNoteSpent(context, h(1), block)).rejects.toThrow(/spent/);
});

it("supports detected encrypted candidates and empty output pages", async () => {
    const { client, requests } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  checkedBits: 8,
                  candidates: [{ fallback: false, note: encryptedOutput() }],
                  creditTransitions: [],
              }
    );
    const result = await client.detectNotes(context, {
        fromBlock: 10n,
        toBlock: 10n,
        detectionKey: new Uint8Array(32).fill(1),
    });
    expect(result.notes).toHaveLength(1);
    expect(requests[1]?.method).toBe("invisi_detectNotes");
    const empty = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : { blockHash: h(10), notes: null, creditTransitions: null }
    );
    expect(
        (await empty.client.getNoteUpdates(context, { fromBlock: 10n, toBlock: 10n })).notes
    ).toEqual([]);
});

it.each([
    { leafIndex: 4 },
    { treeId: "2" },
    { commitment: h(13) },
    { token: "0x3333333333333333333333333333333333333333" },
    { ciphertext: "0x" + "03".repeat(160) },
    { clue: "0x" + "04".repeat(68) },
    { transactionHash: h(23) },
    { logIndex: 5 },
    { kind: "Shield" },
])("rejects conflicting indexed outputs %j", async (patch) => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  notes: [encryptedOutput(), { ...encryptedOutput(), ...patch }],
                  creditTransitions: [],
              }
    );
    await expect(client.getNoteUpdates(context, { fromBlock: 10n, toBlock: 10n })).rejects.toThrow(
        /Conflicting/
    );
});

it("deduplicates equivalent hex casing after output normalization", async () => {
    const output = {
        ...encryptedOutput(),
        ciphertext: "0x" + "ab".repeat(160),
        clue: "0x" + "cd".repeat(68),
    };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  notes: [
                      output,
                      {
                          ...output,
                          ciphertext: "0x" + "AB".repeat(160),
                          clue: "0x" + "CD".repeat(68),
                      },
                  ],
                  creditTransitions: [],
              }
    );
    expect(
        (await client.getNoteUpdates(context, { fromBlock: 10n, toBlock: 10n })).notes
    ).toHaveLength(1);
});
