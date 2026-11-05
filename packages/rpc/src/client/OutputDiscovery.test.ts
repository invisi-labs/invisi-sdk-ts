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
                  outputs: [encryptedOutput()],
                  creditTransitions: [],
              }
    );
    const result = await client.getOutputs(context, { fromBlock: 10n, toBlock: 10n });
    expect(result.outputs[0]).toMatchObject({
        treeId: 1n,
        leafIndex: 3,
        commitment: h(12),
        ciphertext: encryptedOutput().ciphertext,
        block,
    });
    expect(requests.map((r) => r.method)).toEqual(["invisi_getStatus", "invisi_getUpdates"]);
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
                  outputs: [{ ...encryptedOutput(), ...patch }],
                  creditTransitions: [],
              }
    );
    await expect(
        client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })
    ).rejects.toBeInstanceOf(ProtocolRpcError);
});

it("ignores identical indexed outputs", async () => {
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [encryptedOutput(), encryptedOutput()],
                  creditTransitions: [],
              }
    );
    expect(
        (await client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })).outputs
    ).toHaveLength(1);
});

it.each([true, false, "false"])("validates indexed spent observations %j", async (value) => {
    const { client } = setup(() => value);
    if (typeof value === "boolean") expect(await client.isSpent(context, h(1))).toBe(value);
    else await expect(client.isSpent(context, h(1))).rejects.toThrow(/spent/);
});

it("supports detected encrypted candidates and empty output pages", async () => {
    const { client, requests } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  checkedBits: 8,
                  candidates: [{ fallback: false, output: encryptedOutput() }],
                  creditTransitions: [],
              }
    );
    const result = await client.getOutputs(context, {
        fromBlock: 10n,
        toBlock: 10n,
        detectionKey: new Uint8Array(32).fill(1),
    });
    expect(result.outputs).toHaveLength(1);
    expect(requests[1]?.method).toBe("invisi_detectOutputs");
    const empty = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : { blockHash: h(10), outputs: null, creditTransitions: null }
    );
    expect(
        (await empty.client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })).outputs
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
                  outputs: [encryptedOutput(), { ...encryptedOutput(), ...patch }],
                  creditTransitions: [],
              }
    );
    await expect(client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })).rejects.toThrow(
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
                  outputs: [
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
        (await client.getOutputs(context, { fromBlock: 10n, toBlock: 10n })).outputs
    ).toHaveLength(1);
});

it("does not confuse Credit role envelopes with conflicting funds outputs", async () => {
    const credit = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        ciphertext: "0x81" + "ab".repeat(753),
    };
    const change = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        leafIndex: 4,
        commitment: h(13),
        ciphertext: "0x01" + "ab".repeat(160),
    };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [credit, { ...credit, ciphertext: "0x81" + "cd".repeat(753) }, change],
                  creditTransitions: [],
              }
    );
    const page = await client.getOutputs(context, { fromBlock: 10n, toBlock: 10n });
    expect(page.outputs).toHaveLength(1);
    expect(page.outputs[0]?.commitment).toBe(h(13));
});

it("discovers both Credit role envelopes without collapsing a shared commitment", async () => {
    const credit = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        ciphertext: "0x81" + "ab".repeat(753),
    };
    const otherRole = { ...credit, ciphertext: "0x81" + "cd".repeat(753) };
    const { client, requests } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [
                      credit,
                      otherRole,
                      credit,
                      { ...encryptedOutput(), leafIndex: 4, commitment: h(13) },
                  ],
                  creditTransitions: [],
              }
    );
    const page = await client.getCreditOutputs(context, { fromBlock: 10n, toBlock: 10n });
    expect(page.outputs).toHaveLength(2);
    expect(page.outputs.map((output) => output.commitment)).toEqual([h(12), h(12)]);
    expect(requests.map((request) => request.method)).toEqual([
        "invisi_getStatus",
        "invisi_getUpdates",
    ]);
});

it.each([{ treeId: "2" }, { leafIndex: 4 }, { transactionHash: h(99) }, { commitment: h(13) }])(
    "rejects conflicting Credit envelope metadata %j",
    async (patch) => {
        const credit = {
            ...encryptedOutput(),
            kind: "CreditDraw",
            ciphertext: "0x81" + "ab".repeat(753),
        };
        const { client } = setup((method) =>
            method === "invisi_getStatus"
                ? status()
                : {
                      blockHash: h(10),
                      outputs: [
                          credit,
                          { ...credit, ...patch, ciphertext: "0x81" + "cd".repeat(753) },
                      ],
                      creditTransitions: [],
                  }
        );
        await expect(
            client.getCreditOutputs(context, { fromBlock: 10n, toBlock: 10n })
        ).rejects.toThrow(/Conflicting/);
    }
);

it("rejects more than two distinct Credit role envelopes for one leaf", async () => {
    const credit = { ...encryptedOutput(), kind: "CreditToppedUp" };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: ["ab", "cd", "ef"].map((byte) => ({
                      ...credit,
                      ciphertext: "0x81" + byte.repeat(753),
                  })),
                  creditTransitions: [],
              }
    );
    await expect(
        client.getCreditOutputs(context, { fromBlock: 10n, toBlock: 10n })
    ).rejects.toThrow(/Credit role/);
});

it("rejects changed clues for an otherwise identical Credit envelope", async () => {
    const credit = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        ciphertext: "0x81" + "ab".repeat(753),
    };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [credit, { ...credit, clue: "0x" + "cd".repeat(68) }],
                  creditTransitions: [],
              }
    );
    await expect(
        client.getCreditOutputs(context, { fromBlock: 10n, toBlock: 10n })
    ).rejects.toThrow(/Conflicting Credit/);
});

it("preserves unregistered versions in raw and typed candidates without a codec registry", async () => {
    const funds = { ...encryptedOutput(), ciphertext: "0x02" + "ab".repeat(200) };
    const owner = {
        ...encryptedOutput(),
        kind: "CreditCreated",
        leafIndex: 4,
        commitment: h(13),
        ciphertext: "0x82" + "cd".repeat(600),
    };
    const spender = { ...owner, ciphertext: "0x82" + "ef".repeat(600) };
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : {
                  blockHash: h(10),
                  outputs: [funds, owner, spender],
                  creditTransitions: [],
              }
    );
    const range = { fromBlock: 10n, toBlock: 10n };
    expect(
        (await client.getEncryptedOutputs(context, range)).outputs.map((entry) => entry.ciphertext)
    ).toEqual([funds.ciphertext, owner.ciphertext, spender.ciphertext]);
    expect((await client.getOutputs(context, range)).outputs).toHaveLength(1);
    expect((await client.getCreditOutputs(context, range)).outputs).toHaveLength(2);
});

it("preserves mixed empty Funds outputs and classifies empty Credit change as Funds", async () => {
    const outputs = [
        { ...encryptedOutput(), ciphertext: "0x", clue: "0x" },
        { ...encryptedOutput(), leafIndex: 4, commitment: h(13) },
        {
            ...encryptedOutput(),
            kind: "CreditCreated",
            leafIndex: 5,
            commitment: h(14),
            ciphertext: "0x",
            clue: "0x",
        },
        {
            ...encryptedOutput(),
            kind: "CreditCreated",
            leafIndex: 6,
            commitment: h(15),
            ciphertext: "0x81" + "ab".repeat(753),
        },
    ];
    const { client } = setup((method) =>
        method === "invisi_getStatus"
            ? status()
            : { blockHash: h(10), outputs, creditTransitions: [] }
    );
    const range = { fromBlock: 10n, toBlock: 10n };
    expect(
        (await client.getOutputs(context, range)).outputs.map((output) => output.leafIndex)
    ).toEqual([3, 4, 5]);
    expect(
        (await client.getCreditOutputs(context, range)).outputs.map((output) => output.leafIndex)
    ).toEqual([6]);
    expect(
        (await client.getEncryptedOutputs(context, range)).outputs.map((output) => output.leafIndex)
    ).toEqual([3, 4, 5, 6]);
});
