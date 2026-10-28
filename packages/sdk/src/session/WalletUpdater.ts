import { NullifierCapability } from "@invisi-labs/core";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { CanonicalBlock, ProtocolDataProvider } from "@invisi-labs/protocol";
import { decryptCandidates, type DeliveryEventLog } from "./discovery";
import {
    CanonicalConflict,
    CreditMetadataMismatch,
    InventoryProcessor,
    type InventoryOptions,
} from "./inventory";
import { mergeReceiptRecords, mergeSpentObservation } from "./receipts";
import { verifyMembership } from "./membership";
import type { RefreshResult } from "./refresh";
import { readProtocolLogs } from "./receipt-logs";
import { walletBalances, type StoredCredit, type StoredNote } from "./state";

/** Internal candidate references from Protocol RPC; never a claim of complete wallet history. */
export interface CandidatePage {
    context: { chainId: bigint; protocolAddress: Hex };
    block: CanonicalBlock;
    transactionHashes: readonly Hex[];
}
export interface ApplyPageOptions {
    signal?: AbortSignal;
    /** Rebuild private inventory from supplied history after a reorg; preserves uncertain operations. */
    reset?: boolean;
}
const check: (value: unknown, message: string) => asserts value = (value, message) => {
    if (!value) throw new Error(message);
};
const position = (treeId: bigint, leafIndex: number) => `${treeId}:${leafIndex}`;

/** Authenticates indexed candidates before updating private wallet state. */
export class WalletUpdater extends InventoryProcessor {
    readonly #options: InventoryOptions & { protocolRpc: ProtocolDataProvider };

    constructor(options: InventoryOptions & { protocolRpc: ProtocolDataProvider }) {
        super(options);
        this.#options = { ...options };
        check(
            options.viewing.walletIdentity === options.scope.walletIdentity,
            "viewing capability wallet mismatch"
        );
    }

    applyUpdates(batch: CandidatePage, options: ApplyPageOptions = {}): Promise<RefreshResult> {
        return this.run(structuredClone(batch), { ...options });
    }

    private async run(batch: CandidatePage, options: ApplyPageOptions): Promise<RefreshResult> {
        const { reader, protocol, scope, store, viewing } = this.#options;
        const nullifier = NullifierCapability.fromIdentity(scope.walletIdentity);
        const { signal, reset } = options;
        signal?.throwIfAborted();
        const context = protocol.context;
        check(
            batch.context.chainId === context.chainId &&
                batch.context.protocolAddress.toLowerCase() ===
                    context.protocolAddress.toLowerCase(),
            "update deployment context mismatch"
        );
        check(
            batch.block.number >= protocol.deployment.protocol.fromBlock,
            "update precedes deployment"
        );
        await protocol.validateDeployment(reader);
        const base = await store.readSnapshot(scope);
        check(reset || !base.invalidated, "wallet state is invalidated; rebuild required");
        try {
            if (!reset) {
                for (const cursor of [base.observedThrough]) {
                    if (!cursor) continue;
                    if ((await reader.getBlock(cursor.number)).hash !== cursor.hash)
                        throw new CanonicalConflict("Canonical history changed after a reorg");
                    check(
                        cursor.number <= batch.block.number,
                        "update target precedes wallet checkpoint"
                    );
                }
            } else {
                base.notes = {};
                base.credits = {};
            }
            const block = await reader.getBlock(batch.block.number);
            check(
                block.hash === batch.block.hash && block.number === batch.block.number,
                "update target block is not canonical"
            );
            const receipts = [];
            for (const hash of new Set(batch.transactionHashes)) {
                signal?.throwIfAborted();
                check(/^0x[0-9a-fA-F]{64}$/.test(hash), "invalid candidate transaction hash");
                const receipt = await reader.getReceipt(hash);
                check(
                    receipt &&
                        receipt.status === "success" &&
                        receipt.transactionHash.toLowerCase() === hash.toLowerCase(),
                    "invalid or unsuccessful candidate receipt"
                );
                check(
                    receipt.block.number >= protocol.deployment.protocol.fromBlock &&
                        receipt.block.number <= block.number,
                    "candidate receipt outside update range"
                );
                if ((await reader.getBlock(receipt.block.number)).hash !== receipt.block.hash)
                    throw new CanonicalConflict("Candidate receipt disagrees with canonical chain");
                receipts.push(receipt);
            }
            const logs = receipts.flatMap((receipt) =>
                readProtocolLogs(receipt, context.protocolAddress)
            );
            logs.sort((a, b) =>
                a.blockNumber! < b.blockNumber!
                    ? -1
                    : a.blockNumber! > b.blockNumber!
                      ? 1
                      : a.logIndex! - b.logIndex!
            );
            // Positions come from independently obtained canonical receipts, not service metadata.
            const leaves = new Map<string, bigint>();
            for (const event of logs) {
                if (event.eventName !== "CommitmentsInserted" && event.eventName !== "BatchOutputs")
                    continue;
                const { treeId, startLeafIndex, commitments } = event.args as {
                    treeId: bigint;
                    startLeafIndex: bigint;
                    commitments: Hex[];
                };
                for (const [i, commitment] of commitments.entries()) {
                    const key = position(treeId, Number(startLeafIndex) + i);
                    check(
                        !leaves.has(key) || leaves.get(key) === BigInt(commitment),
                        "conflicting canonical insertion"
                    );
                    leaves.set(key, BigInt(commitment));
                }
            }
            const getLeaf = (tree: bigint, index: number) => {
                const leaf = leaves.get(position(tree, index));
                check(leaf !== undefined, "missing canonical insertion");
                return leaf;
            };
            const decrypted = await decryptCandidates(logs, {
                context,
                viewing,
                confirmedThrough: block.number,
            });
            const notes: StoredNote[] = decrypted.notes.map((record) => ({
                ...record,
                spent: "unknown",
            }));
            const incoming: StoredCredit[] = decrypted.credits.map((record) => ({
                ...record,
                spent: "unknown",
            }));
            const recovered = await this.recoverCredits(base, incoming, logs, { getLeaf });
            const creditsByKey = new Map(
                incoming.map((record) => [record.commitment + ":" + record.role, record])
            );
            for (const record of recovered)
                creditsByKey.set(record.commitment + ":" + record.role, record);
            const credits = [...creditsByKey.values()]
                .filter((record) => {
                    try {
                        this.checkSnapshotKeys(record);
                        return true;
                    } catch (error) {
                        if (error instanceof CreditMetadataMismatch) return false;
                        throw error;
                    }
                })
                .sort((a, b) =>
                    a.blockNumber < b.blockNumber
                        ? -1
                        : a.blockNumber > b.blockNumber
                          ? 1
                          : a.treeId < b.treeId
                            ? -1
                            : a.treeId > b.treeId
                              ? 1
                              : a.leafIndex - b.leafIndex
                );
            for (const record of [...notes, ...credits]) {
                signal?.throwIfAborted();
                const proof = await this.#options.protocolRpc.getMembership(context, record, block);
                const tokenAddress =
                    "note" in record ? record.note.tokenAddress : record.state.note.tokenAddress;
                await verifyMembership(
                    reader,
                    {
                        ...context,
                        tokenAddress: `0x${tokenAddress.toString(16).padStart(40, "0")}`,
                    },
                    block,
                    record,
                    proof
                );
            }
            const allNotes = {
                ...base.notes,
                ...Object.fromEntries(notes.map((record) => [record.commitment, record])),
            };
            const allCredits = {
                ...base.credits,
                ...Object.fromEntries(
                    credits.map((record) => [record.commitment + ":" + record.role, record])
                ),
            };
            const observations: Array<{ kind: "notes" | "credits"; id: string; nullifier: Hex }> =
                [];
            for (const [id, record] of Object.entries(allNotes))
                observations.push({
                    kind: "notes",
                    id,
                    nullifier: await nullifier.compute(
                        scope.chainId,
                        record.commitment,
                        record.note.nonce
                    ),
                });
            for (const [id, record] of Object.entries(allCredits))
                observations.push({
                    kind: "credits",
                    id,
                    nullifier: await this.creditNullifier(record.state),
                });
            const spent = observations.length
                ? await reader.isSpent(
                      context,
                      observations.map((item) => item.nullifier),
                      block
                  )
                : [];
            check(
                spent.length === observations.length &&
                    spent.every((value) => typeof value === "boolean"),
                "invalid spent-state response"
            );
            signal?.throwIfAborted();
            if ((await reader.getBlock(block.number)).hash !== block.hash)
                throw new CanonicalConflict("Canonical block changed during update");
            await store.transaction(scope, (draft) => {
                signal?.throwIfAborted();
                check(draft.revision === base.revision, "wallet changed during update; retry");
                if (reset) {
                    this.reorgOperations(draft);
                    draft.notes = {};
                    draft.credits = {};
                    delete draft.observedThrough;
                    delete draft.invalidated;
                }
                mergeReceiptRecords(draft, { notes, credits, checkpoint: block });
                observations.forEach((item, index) => {
                    const record = draft[item.kind][item.id];
                    if (record) {
                        mergeSpentObservation(record, {
                            spent: spent[index] ? "spent" : "unspent",
                            checkedThrough: { number: block.number, hash: block.hash },
                        });
                    }
                });
                // Candidate processing cannot establish complete or FMD scan coverage.
                draft.observedThrough = { number: block.number, hash: block.hash };
            });
            return {
                block,
                notes: notes.length,
                credits: credits.length,
                balances: walletBalances(await store.readSnapshot(scope)),
            };
        } catch (error) {
            if (error instanceof CanonicalConflict) await this.invalidate();
            throw error;
        }
    }
}
