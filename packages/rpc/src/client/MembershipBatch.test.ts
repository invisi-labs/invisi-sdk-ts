import { poseidonHash, TREE_DEPTH } from "@invisi-labs/primitives";
import { expect, it, vi } from "vitest";
import { block, context, h, setup, status, wireBlock } from "./ProtocolRpcClient-fixtures";

async function fixture() {
    const leaves = [1n, 2n];
    let root = BigInt(await poseidonHash(leaves));
    const tail: string[] = [];
    for (let i = 1; i < TREE_DEPTH; i++) {
        tail.push(h(0));
        root = BigInt(await poseidonHash([root, 0n]));
    }
    const anchor = { treeId: 1, leafCount: 2, root: h(root), block: wireBlock };
    const proofs = leaves.map((leaf, i) => ({
        anchor,
        leafIndex: i,
        commitment: h(leaf),
        siblings: [h(leaves[1 - i]!), ...tail],
    }));
    const inputs = leaves.map((leaf, i) => ({ treeId: 1n, leafIndex: i, commitment: h(leaf) }));
    return { anchor, proofs, inputs };
}

it("shares batch status, root and chain evidence while preserving input order and each proof", async () => {
    const f = await fixture();
    const { client, reader, requests } = setup((method, params) =>
        method === "invisi_getStatus"
            ? status()
            : method === "invisi_getRoots"
              ? [f.anchor]
              : f.proofs[Number(params[1])]
    );
    const proofs = await client.getMemberships(context, [...f.inputs].reverse(), block);
    expect(proofs.map((p) => p.leafIndex)).toEqual([1, 0]);
    expect(requests.filter((r) => r.method === "invisi_getStatus")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "invisi_getRoots")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "invisi_getMembership")).toHaveLength(2);
    expect(reader.isKnownRoot).toHaveBeenCalledTimes(1);
    f.proofs[0]!.siblings[0] = h(8);
    await expect(client.getMemberships(context, f.inputs, block)).rejects.toThrow(/proof root/);
});

it("fails the entire batch on malformed status and changed canonical end fence", async () => {
    const f = await fixture();
    const bad = setup(() => ({ ...status(), protocolVersion: "2" }));
    await expect(bad.client.getMemberships(context, f.inputs, block)).rejects.toThrow();
    expect(bad.requests.map((r) => r.method)).toEqual(["invisi_getStatus"]);
    const { client, reader } = setup((method, params) =>
        method === "invisi_getStatus"
            ? status()
            : method === "invisi_getRoots"
              ? [f.anchor]
              : f.proofs[Number(params[1])]
    );
    let reads = 0;
    reader.getBlock = vi.fn(async (_number: bigint) =>
        ++reads >= 4 ? { ...block, hash: h(99) } : block
    );
    await expect(client.getMemberships(context, f.inputs, block)).rejects.toThrow(/canonical/);
});

it("rejects oversized batches before requests and does not retain evidence between batches", async () => {
    const f = await fixture();
    const { client, requests } = setup((method, params) =>
        method === "invisi_getStatus"
            ? status()
            : method === "invisi_getRoots"
              ? [f.anchor]
              : f.proofs[Number(params[1])]
    );
    await expect(
        client.getMemberships(context, Array(257).fill(f.inputs[0]), block)
    ).rejects.toThrow(/256/);
    expect(requests).toHaveLength(0);
    await client.getMemberships(context, f.inputs, block);
    await client.getMemberships(context, f.inputs, block);
    expect(requests.filter((r) => r.method === "invisi_getStatus")).toHaveLength(2);
});

it.each(["commitment", "leafIndex", "siblings", "anchor"])(
    "rejects one malformed %s binding without returning a partial batch",
    async (field) => {
        const f = await fixture();
        const proof = f.proofs[1]!;
        if (field === "commitment") proof.commitment = h(9);
        if (field === "leafIndex") proof.leafIndex = 0;
        if (field === "siblings") proof.siblings = [h(0)];
        if (field === "anchor") proof.anchor = { ...f.anchor, leafCount: 1 };
        const { client } = setup((method, params) =>
            method === "invisi_getStatus"
                ? status()
                : method === "invisi_getRoots"
                  ? [f.anchor]
                  : f.proofs[Number(params[1])]
        );
        await expect(client.getMemberships(context, f.inputs, block)).rejects.toThrow();
    }
);

it("selects one root covering the highest leaf of each tree", async () => {
    const f = await fixture();
    f.anchor.block = { number: 9, hash: h(9), parentHash: h(8), timestamp: 123 };
    const newest = { ...f.anchor, leafCount: 1, root: h(99), block: wireBlock };
    const { client, requests } = setup((method, params) =>
        method === "invisi_getStatus"
            ? status()
            : method === "invisi_getRoots"
              ? [newest, f.anchor]
              : f.proofs[Number(params[1])]
    );
    const result = await client.getMemberships(context, f.inputs, block);
    expect(result.map((proof) => proof.root)).toEqual([f.anchor.root, f.anchor.root]);
    expect(
        requests.filter((r) => r.method === "invisi_getMembership").map((r) => r.params[2])
    ).toEqual([f.anchor.root, f.anchor.root]);
});

it("rejects conflicting pinned roots within a tree before requesting evidence", async () => {
    const f = await fixture();
    const { client, requests } = setup(() => status());
    await expect(
        client.getMemberships(
            context,
            f.inputs.map((input, i) => ({ ...input, root: h(i + 1) })),
            block
        )
    ).rejects.toThrow(/conflicting/i);
    expect(requests).toHaveLength(0);
});

it("rejects a used earlier root anchor changing while the requested block stays canonical", async () => {
    const f = await fixture();
    f.anchor.block = { number: 9, hash: h(9), parentHash: h(8), timestamp: 123 };
    let changed = false;
    const { client, reader } = setup((method, params) => {
        if (method === "invisi_getStatus") return status();
        if (method === "invisi_getRoots") return [f.anchor];
        changed = true;
        return f.proofs[Number(params[1])];
    });
    reader.getBlock = vi.fn(async (number: bigint) =>
        number === 9n ? { ...block, number, hash: changed ? h(99) : h(9), parentHash: h(8) } : block
    );
    await expect(client.getMemberships(context, f.inputs, block)).rejects.toThrow(/canonical/);
});
