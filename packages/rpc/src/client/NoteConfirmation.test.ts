import { expect, it } from "vitest";
import { TREE_DEPTH, poseidonHash } from "@invisi-labs/primitives";
import { setup, h, wireBlock, context, status } from "./ProtocolRpcClient-fixtures";

async function noteFixture() {
    const siblings = Array.from({ length: TREE_DEPTH }, () => h(0));
    let root = h(1);
    for (const sibling of siblings) root = await poseidonHash([BigInt(root), BigInt(sibling)]);
    const anchor = { treeId: 1, leafCount: 1, root, block: wireBlock };
    const membership = { anchor, leafIndex: 0, commitment: h(1), siblings };
    const output = {
        block: wireBlock,
        treeId: 1,
        leafIndex: 0,
        commitment: h(1),
        token: "0x2222222222222222222222222222222222222222",
        ciphertext: "0x",
        clue: "0x",
        transactionHash: h(22),
        logIndex: 0,
        kind: "NoteOutputs",
    };
    return { root, anchor, membership, output };
}

async function confirmed() {
    const f = await noteFixture();
    return {
        ...status(),
        status: "confirmed",
        reason: null,
        output: f.output,
        membership: f.membership,
        confirmation: { finality: "finalized", verifiedAt: wireBlock, finalityHead: wireBlock },
    };
}
it("validates trusted confirmation without touching a chain reader", async () => {
    const { client, reader, requests } = setup(() => confirmedValue);
    const confirmedValue = await confirmed();
    expect((await client.getNoteFromTrustedRpc(context, h(1), "finalized")).status).toBe(
        "confirmed"
    );
    expect(reader.getBlock).not.toHaveBeenCalled();
    expect(reader.isKnownRoot).not.toHaveBeenCalled();
    expect(requests.map((r) => [r.method, r.params])).toEqual([
        ["invisi_getNote", [h(1), { finality: "finalized" }]],
    ]);
});
it("rejects contradictory, forged, and unpinned trusted evidence", async () => {
    const valid = await confirmed();
    const cases = [
        null,
        { ...valid, apiVersion: "v2" },
        { ...valid, reason: "pending_index" },
        { ...valid, deployment: { ...valid.deployment, chainId: "1" } },
        { ...valid, confirmation: { ...valid.confirmation, finality: "safe" } },
        {
            ...valid,
            membership: {
                ...valid.membership,
                siblings: valid.membership.siblings.map(() => h(3)),
            },
        },
        { ...valid, indexedHead: { ...wireBlock, hash: h(4) } },
        { ...valid, output: { ...valid.output, block: { ...wireBlock, timestamp: 124 } } },
        {
            ...valid,
            confirmation: { ...valid.confirmation, verifiedAt: { ...wireBlock, number: 11 } },
        },
        { ...valid, status: "pending", reason: "pending_index" },
    ];
    for (const value of cases)
        await expect(
            setup(() => value).client.getNoteFromTrustedRpc(context, h(1), "finalized")
        ).rejects.toThrow();
    await expect(
        setup(() => valid, { deployment: undefined }).client.getNoteFromTrustedRpc(
            context,
            h(1),
            "finalized"
        )
    ).rejects.toThrow();
});
it("returns explicitly pending evidence and rejects unknown reasons and selectors", async () => {
    const value = {
        ...status(),
        status: "pending",
        reason: "not_observed",
        output: null,
        membership: null,
        confirmation: null,
    };
    expect(
        (await setup(() => value).client.getNoteFromTrustedRpc(context, h(1), "safe")).status
    ).toBe("pending");
    await expect(
        setup(() => ({ ...value, reason: "missing" })).client.getNoteFromTrustedRpc(
            context,
            h(1),
            "safe"
        )
    ).rejects.toThrow();
    await expect(
        setup(() => value).client.getNoteFromTrustedRpc(context, h(1), "latest" as "safe")
    ).rejects.toThrow();
});

it("works with no reader and validates proof bounds and head coverage", async () => {
    const valid = await confirmed();
    expect(
        (
            await setup(() => valid, { reader: undefined }).client.getNoteFromTrustedRpc(
                context,
                h(1),
                "finalized"
            )
        ).status
    ).toBe("confirmed");
    for (const bad of [
        {
            ...valid,
            membership: {
                ...valid.membership,
                anchor: { ...valid.membership.anchor, leafCount: 0 },
            },
        },
        {
            ...valid,
            membership: { ...valid.membership, anchor: { ...valid.membership.anchor, treeId: 2 } },
        },
        { ...valid, membership: { ...valid.membership, siblings: [] } },
        {
            ...valid,
            confirmation: { ...valid.confirmation, finalityHead: { ...wireBlock, number: 9 } },
        },
        { ...valid, output: { ...valid.output, commitment: h(2) } },
        { ...valid, output: { ...valid.output, leafIndex: 65536 } },
    ])
        await expect(
            setup(() => bad).client.getNoteFromTrustedRpc(context, h(1), "finalized")
        ).rejects.toThrow();
});

it("accepts the RPC server's shared finalized fixture with pinned deployment and no reader", async () => {
    const { readFileSync } = await import("node:fs");
    const { defineDeployment } = await import("../deployment/deployment");
    const fixture = JSON.parse(
        readFileSync(new URL("./testdata/note-confirmation.json", import.meta.url), "utf8")
    );
    const deployment = defineDeployment(fixture.deployment);
    const { client } = setup(() => fixture, { deployment, reader: undefined });
    const result = await client.getNoteFromTrustedRpc(
        { chainId: deployment.chainId, protocolAddress: deployment.protocol.address },
        h(1),
        "finalized"
    );
    expect(result.status).toBe("confirmed");
    if (result.status === "confirmed")
        expect(result.membership.anchor.root).toBe(fixture.membership.anchor.root);
});
it.each(["zero transaction hash", "duplicate block hash"])("rejects %s", async (mutation) => {
    const valid = await confirmed();
    const value =
        mutation === "zero transaction hash"
            ? { ...valid, output: { ...valid.output, transactionHash: h(0) } }
            : {
                  ...valid,
                  confirmation: {
                      ...valid.confirmation,
                      finalityHead: { ...wireBlock, number: 12 },
                  },
              };
    await expect(
        setup(() => value).client.getNoteFromTrustedRpc(context, h(1), "finalized")
    ).rejects.toThrow();
});

it.each(["zero hash", "large height", "large timestamp", "large output tree", "large anchor tree"])(
    "rejects trusted %s",
    async (mutation) => {
        const value = await confirmed();
        const huge = "9007199254740992";
        const bad = mutation.includes("tree")
            ? {
                  ...value,
                  output: { ...value.output, treeId: huge },
                  membership: {
                      ...value.membership,
                      anchor: { ...value.membership.anchor, treeId: huge },
                  },
              }
            : JSON.parse(JSON.stringify(value), (key, v) =>
                  key === "number" && mutation === "large height"
                      ? huge
                      : key === "timestamp" && mutation === "large timestamp"
                        ? huge
                        : key === "hash" && mutation === "zero hash"
                          ? h(0)
                          : v
              );
        await expect(
            setup(() => bad).client.getNoteFromTrustedRpc(context, h(1), "finalized")
        ).rejects.toThrow();
    }
);
it("requires explicit application pins after discovery and reader cloning", async () => {
    const value = await confirmed();
    const { client, reader, requests } = setup(
        (method) => (method === "invisi_getDeployment" ? status() : value),
        { deployment: undefined }
    );
    await client.getDeployment(context.chainId);
    const clone = client.withReader(reader);
    for (const candidate of [client, clone])
        await expect(candidate.getNoteFromTrustedRpc(context, h(1), "finalized")).rejects.toThrow(
            /explicit.*deployment/i
        );
    expect(requests.map((r) => r.method)).toEqual(["invisi_getDeployment"]);
});

it("rejects zero commitments before calling the trusted RPC", async () => {
    const { client, requests } = setup(() => null);
    await expect(client.getNoteFromTrustedRpc(context, h(0), "finalized")).rejects.toThrow(
        /nonzero/i
    );
    expect(requests).toHaveLength(0);
});
