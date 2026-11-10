import { expect, it } from "vitest";
import { TREE_DEPTH, poseidonHash } from "@invisi-labs/primitives";
import { setup, h, block, wireBlock, context, status } from "./ProtocolRpcClient-fixtures";

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
        kind: "Shield",
    };
    return { root, anchor, membership, output };
}
it("locates commitment and authenticates the returned proof through the chain", async () => {
    const f = await noteFixture();
    const { client, requests } = setup(
        (method) =>
            ({
                invisi_getStatus: status(),
                invisi_getNote: { output: f.output, membership: f.membership },
                invisi_getRoots: [f.anchor],
                invisi_getMembership: f.membership,
            })[method]
    );
    const result = await client.getNote(context, h(1), block);
    expect(result?.membership.root).toBe(f.root);
    expect(result?.output.leafIndex).toBe(0);
    expect(requests.find((r) => r.method === "invisi_getNote")?.params).toEqual([h(1), 10]);
});
it("returns null for missing commitments and rejects mismatched proof bindings", async () => {
    const missing = setup(() => null);
    expect(await missing.client.getNote(context, h(1), block)).toBeNull();
    const f = await noteFixture();
    for (const bad of [
        { ...f.membership, commitment: h(2) },
        { ...f.membership, siblings: f.membership.siblings.map(() => h(3)) },
        { ...f.membership, leafIndex: 1 },
    ]) {
        const { client } = setup(
            (method) =>
                ({
                    invisi_getStatus: status(),
                    invisi_getNote: { output: f.output, membership: bad },
                    invisi_getRoots: [f.anchor],
                    invisi_getMembership: f.membership,
                })[method]
        );
        await expect(client.getNote(context, h(1), block)).rejects.toThrow(/binding|proof/);
    }
});
