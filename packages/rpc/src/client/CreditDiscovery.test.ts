import { expect, it } from "vitest";
import { TREE_DEPTH, poseidonHash } from "@invisi-labs/primitives";
import {
    block,
    context,
    encryptedOutput,
    h,
    setup,
    status,
    transactionWire,
    wireBlock,
} from "./ProtocolRpcClient-fixtures";

const range = { fromBlock: 10n, toBlock: 10n };
const delivery = (byte = "ab") => ({
    ciphertext: "0x81" + byte.repeat(80),
    clue: "0x" + "02".repeat(68),
});
const state = () => {
    const { ciphertext: _ciphertext, clue: _clue, ...metadata } = encryptedOutput();
    return { ...metadata, kind: "CreditCreated", deliveries: [delivery(), delivery("cd")] };
};
const event = (name = "CreditCreated") => ({
    block: wireBlock,
    name,
    transactionHash: h(22),
    logIndex: 4,
    data: { revocationShard: "18446744073709551615", revocationSlot: 65535 },
});
it("does not classify Credit states as Notes from an envelope header", async () => {
    const { client } = setup((m) =>
        m === "invisi_getStatus"
            ? status()
            : { blockHash: h(10), notes: [{ ...encryptedOutput(), kind: "CreditCreated" }] }
    );
    await expect(client.getNoteUpdates(context, range)).rejects.toThrow(
        "Credit state cannot appear"
    );
});
it("validates canonical Credit event names and retains public shard precision", async () => {
    const { client } = setup((m) => (m === "invisi_getStatus" ? status() : [event(), event()]));
    const page = await client.getCreditTransitions(context, range);
    expect(page.transitions).toHaveLength(1);
    expect(page.transitions[0]?.data.revocationShard).toBe("18446744073709551615");
    expect("notes" in page).toBe(false);
});
it.each(["CreditCancelled", "CreditToppedUp", "Transact"])(
    "rejects event from other model %s",
    async (name) => {
        const { client } = setup((m) => (m === "invisi_getStatus" ? status() : [event(name)]));
        await expect(client.getCreditTransitions(context, range)).rejects.toThrow(
            "Invalid Credit transition"
        );
    }
);
it("queries Credit consumption independently from Note spent state", async () => {
    const { client, requests } = setup(() => true);
    expect(await client.isCreditConsumed(context, h(1), block)).toBe(true);
    expect(await client.isNoteSpent(context, h(2), block)).toBe(true);
    expect(requests.map((r) => r.method)).toEqual([
        "invisi_isCreditConsumed",
        "invisi_isNoteSpent",
    ]);
    expect(requests.map((r) => r.params[1])).toEqual([10, 10]);
});
it("validates grant query anchors, bitmap bounds and uint64 shard precision", async () => {
    const owner = "0x1111111111111111111111111111111111111111",
        token = "0x2222222222222222222222222222222222222222";
    const { client, requests } = setup((m) =>
        m === "invisi_getCreditAllocation"
            ? { block: wireBlock, shard: "18446744073709551615", slot: 65535 }
            : { block: wireBlock, bitmap: (1n << 255n).toString() }
    );
    expect(await client.getCreditAllocation(context, owner, token, block)).toMatchObject({
        shard: (1n << 64n) - 1n,
        slot: 65535,
    });
    expect(
        await client.getCreditRevocationBitmap(context, owner, token, 1n, 255, block)
    ).toMatchObject({ bitmap: 1n << 255n });
    expect(requests[1]?.params).toEqual([owner, token, "1", 255, 10]);
    await expect(
        client.getCreditRevocationBitmap(context, owner, token, 0n, 0, block)
    ).rejects.toThrow("location");
    await expect(
        client.getCreditRevocationBitmap(context, owner, token, 1n, 256, block)
    ).rejects.toThrow("location");
});
it("authenticates Credit state membership and preserves both deliveries", async () => {
    const siblings = Array.from({ length: TREE_DEPTH }, () => h(0));
    let root = h(12);
    for (const sibling of siblings) root = await poseidonHash([BigInt(root), BigInt(sibling)]);
    const anchor = { treeId: 1, leafCount: 1, root, block: wireBlock },
        membership = { anchor, leafIndex: 0, commitment: h(12), siblings };
    const raw = { ...state(), leafIndex: 0 };
    const { client } = setup(
        (m) =>
            ({
                invisi_getStatus: status(),
                invisi_getCreditState: { state: raw, membership },
                invisi_getRoots: [anchor],
                invisi_getMembership: membership,
            })[m]
    );
    const found = await client.getCreditState(context, h(12), block);
    expect(found?.membership.root).toBe(root);
    expect(found?.state.deliveries).toHaveLength(2);
});
it("returns Credit transaction state records and transitions without Note arrays", async () => {
    const raw = { ...state(), transactionHash: h(123) };
    const { client } = setup((m) =>
        m === "invisi_getStatus"
            ? status()
            : {
                  ...transactionWire(),
                  states: [raw],
                  transitions: [{ ...event(), transactionHash: h(123) }],
              }
    );
    const result = await client.getTransactionCreditUpdates(context, h(123));
    expect(result.status).toBe("indexed");
    if (result.status !== "indexed") throw new Error("indexed required");
    expect(result.states[0]?.deliveries).toHaveLength(2);
    expect(result.transitions).toHaveLength(1);
    expect("notes" in result).toBe(false);
});

it.each([
    { kind: "Transact" },
    { deliveries: [delivery()] },
    { deliveries: [delivery(), delivery(), delivery()] },
    { deliveries: [delivery(), { ciphertext: "0x", clue: "0x" }] },
    { deliveries: [delivery(), { ...delivery(), clue: "0x12" }] },
    { commitment: h(1n << 255n) },
])("rejects malformed public transaction Credit states %j", async (patch) => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  ...transactionWire(),
                  states: [{ ...state(), transactionHash: h(123), ...patch }],
                  transitions: [],
              }
    );
    await expect(client.getTransactionCreditUpdates(context, h(123))).rejects.toThrow();
});
it("rejects conflicting public transaction Credit envelopes sharing a leaf", async () => {
    const raw = { ...state(), transactionHash: h(123) };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  ...transactionWire(),
                  states: [raw, { ...raw, deliveries: [delivery("ef"), delivery("cd")] }],
                  transitions: [],
              }
    );
    await expect(client.getTransactionCreditUpdates(context, h(123))).rejects.toThrow(
        "Conflicting"
    );
});
