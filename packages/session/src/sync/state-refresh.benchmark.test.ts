import { computeNoteCommitment, computeNoteIdentity } from "@invisi-labs/primitives";
import { expect, it, vi } from "vitest";
import { MerkleFixture } from "../../../../test-support/merkle-fixture";
import { fixture } from "../../../../test-support/operation-fixture";
import { sessionOptions } from "../../../../test-support/session-options";
import { WalletSession } from "../wallet/WalletSession";

// Real scanning/snapshot code with a single-path provider; synthetic latency excludes CPU cost.
// Run: pnpm --filter @invisi-labs/session test -- state-refresh.benchmark.test.ts
it("benchmarks full preparation refresh against inventory-only refresh", async () => {
    const rows: object[] = [];
    for (const size of [1, 8, 32, 128]) {
        const h = await fixture();
        const seed = (await h.store.readSnapshot(h.scope)).notes[h.leaf]!;
        const trees = new Map([[1n, h.tree]]);
        for (let index = 1; index < size; index++) {
            const note = { ...h.note, nonce: BigInt(123 + index) };
            const commitment = await computeNoteCommitment(
                note.chainId,
                note.protocolAddress,
                await computeNoteIdentity(BigInt(note.ownerAddress), note.nonce),
                note.tokenAddress,
                note.amount
            );
            const treeId = BigInt(Math.floor(index / 8) + 1);
            if (!trees.has(treeId)) trees.set(treeId, await MerkleFixture.create());
            const leafIndex = await trees.get(treeId)!.insert(BigInt(commitment));
            await h.store.transaction(h.scope, (draft) => {
                draft.notes[commitment] = { ...seed, note, commitment, treeId, leafIndex };
            });
        }
        const measure = async (inventoryOnly: boolean) => {
            let chainReads = 0,
                paths = 0;
            const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
            const reader = new Proxy(h.reader, {
                get(target, name) {
                    const value = Reflect.get(target, name, target);
                    if (typeof value !== "function") return value;
                    return async (...args: unknown[]) => {
                        chainReads++;
                        await sleep(2);
                        return value.apply(target, args);
                    };
                },
            });
            const rpc = {
                ...h.membership,
                getMembership: async (...args: Parameters<typeof h.membership.getMembership>) => {
                    paths++;
                    await sleep(5);
                    const [, input, block] = args;
                    const proof = trees.get(input.treeId)!.getProof(input.leafIndex);
                    return {
                        treeId: input.treeId,
                        leafIndex: input.leafIndex,
                        leaf: input.commitment,
                        root: `0x${proof.root.toString(16).padStart(64, "0")}` as const,
                        path: proof.merklePath,
                        block,
                    };
                },
            };
            const session = new WalletSession(
                sessionOptions({ ...h.options, chainReader: reader, protocolRpc: rpc })
            );
            vi.useFakeTimers();
            vi.setSystemTime(0);
            try {
                const task = session.scanHistory(
                    {
                        async decryptNote() {
                            throw Error("unexpected decrypt");
                        },
                        async decryptCredit() {
                            throw Error("unexpected decrypt");
                        },
                    },
                    { fromBlock: 13n, toBlock: 12n, inventoryOnly }
                );
                await vi.runAllTimersAsync();
                const result = await task;
                expect(result.balances[0]!.availableKnown).toBe(BigInt(size) * 100n);
                expect(!!(await h.store.readSnapshot(h.scope)).preparationSnapshot).toBe(
                    !inventoryOnly
                );
                return { chainReads, paths, modeledElapsedMs: Date.now() };
            } finally {
                vi.useRealTimers();
            }
        };
        const full = await measure(false),
            inventoryOnly = await measure(true);
        expect(full.paths).toBe(size);
        expect(inventoryOnly.paths).toBe(0);
        expect(inventoryOnly.modeledElapsedMs).toBeLessThan(full.modeledElapsedMs);
        rows.push({ size, full, inventoryOnly });
    }
    console.info(
        "State refresh benchmark (virtual network latency, crypto CPU excluded):",
        JSON.stringify(rows)
    );
}, 30_000);
