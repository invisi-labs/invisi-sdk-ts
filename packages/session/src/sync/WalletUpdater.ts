import type { PreparationCapture } from "./preparation-capture";
import { mergeCoverage } from "../public-history/coverage";
import { certifiedHistoryBatch, certifyHistoryBatch } from "../public-history/authentication";
import { historyPosition } from "../public-history/store";
import { NullifierCapability } from "@invisi-labs/primitives";
import type { CanonicalBlock, ProtocolDataProvider } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import {
    decryptCandidates,
    extractDeliveryCandidates,
    readProtocolLogs,
    verifyMembership,
} from "@invisi-labs/sdk/session-support";
import {
    CanonicalConflict,
    CreditMetadataMismatch,
    InventoryProcessor,
    type InventoryOptions,
} from "../inventory/inventory";
import { walletBalances, type StoredCredit, type StoredNote } from "../storage/state";
import { mergeReceiptRecords, mergeSpentObservation } from "./receipts";
import type { RefreshResult } from "./refresh";

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
    refreshState?: boolean;
    observationBlock?: import("@invisi-labs/protocol").CanonicalBlock;
    discoveryFrom?: bigint;
    recoveryBoundary?: bigint;
    discoveryBlock?: import("../storage/state").Checkpoint;
    creditOnly?: boolean;
    queueCreditReplay?: boolean;
    creditReplayBlock?: import("../storage/state").Checkpoint;
    creditReplayComplete?: boolean;
    creditReplayRevision?: number;
    historyGeneration?: number;
    beforeCommit?: () => Promise<void>;
}
const check: (value: unknown, message: string) => asserts value = (value, message) => {
    if (!value) throw new Error(message);
};
const position = (treeId: bigint, leafIndex: number) => `${treeId}:${leafIndex}`;

/** Authenticates indexed candidates before updating private wallet state. */
export class WalletUpdater extends InventoryProcessor {
    readonly #options: InventoryOptions & {
        protocolRpc: ProtocolDataProvider;
        preparationCapture?: PreparationCapture;
    };

    constructor(
        options: InventoryOptions & {
            protocolRpc: ProtocolDataProvider;
            preparationCapture?: PreparationCapture;
        }
    ) {
        super(options);
        this.#options = { ...options };
        check(
            options.viewing.ownerAddress === options.scope.ownerAddress,
            "viewing capability wallet mismatch"
        );
    }

    applyUpdates(batch: CandidatePage, options: ApplyPageOptions = {}): Promise<RefreshResult> {
        const copy = structuredClone(batch);
        const page = certifiedHistoryBatch(batch);
        if (page) certifyHistoryBatch(copy, page);
        return this.run(copy, { ...options });
    }

    private async run(batch: CandidatePage, options: ApplyPageOptions): Promise<RefreshResult> {
        const { reader, protocol, scope, store, viewing } = this.#options;
        const nullifier = NullifierCapability.fromIdentity(scope.ownerAddress);
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
        const cachedPage = certifiedHistoryBatch(batch);
        if (!cachedPage) await protocol.validateDeployment(reader);
        const base = await store.readSnapshot(scope);
        if (options.creditReplayRevision !== undefined)
            check(
                (base.creditReplayRevision ?? 0) === options.creditReplayRevision,
                "Credit recovery changed; retry"
            );
        check(reset || !base.invalidated, "wallet state is invalidated; rebuild required");
        try {
            if (!reset) {
                for (const cursor of [base.observedThrough]) {
                    if (!cursor) continue;
                    if ((await reader.getBlock(cursor.number)).hash !== cursor.hash)
                        throw new CanonicalConflict("Canonical history changed after a reorg");
                    check(
                        !!cachedPage || cursor.number <= batch.block.number,
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
            const observation = options.observationBlock ?? block;
            check(
                observation.number >= block.number,
                "spent observation precedes discovery target"
            );
            const receipts = [];
            for (const hash of cachedPage ? [] : new Set(batch.transactionHashes)) {
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
            const logs = cachedPage
                ? structuredClone(cachedPage.logs)
                : receipts.flatMap((receipt) => readProtocolLogs(receipt, context.protocolAddress));
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
                if (event.eventName !== "CommitmentsInserted") continue;
                const { treeId, startLeafIndex } = event.args as {
                    treeId: bigint;
                    startLeafIndex: bigint;
                };
                const commitments = (event.args as Record<string, unknown>)["commitments"] as Hex[];
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
                ...(options.creditOnly ? { roles: ["owner", "spender"] as const } : {}),
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
                if (
                    cachedPage?.verifiedPositions.includes(
                        historyPosition(record.treeId, record.leafIndex, record.commitment)
                    )
                )
                    continue;
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
                this.#options.preparationCapture?.rememberMembership(record, proof);
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
                        BigInt(scope.protocolAddress),
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
            const spent =
                options.refreshState !== false && observations.length
                    ? await reader.isSpent(
                          context,
                          observations.map((item) => item.nullifier),
                          observation
                      )
                    : [];
            check(
                (options.refreshState === false || spent.length === observations.length) &&
                    spent.every((value) => typeof value === "boolean"),
                "invalid spent-state response"
            );
            signal?.throwIfAborted();
            if ((await reader.getBlock(block.number)).hash !== block.hash)
                throw new CanonicalConflict("Canonical block changed during update");
            const revocations = new Map<string, boolean>();
            if (options.refreshState !== false && reader.getCreditRevocationBitmap) {
                for (const [id, record] of Object.entries(allCredits)) {
                    const note = record.state.note;
                    const bitmap = await reader.getCreditRevocationBitmap(
                        context,
                        note.ownerWalletIdentity,
                        `0x${note.tokenAddress.toString(16).padStart(40, "0")}`,
                        note.revocationShard,
                        Number(note.revocationSlot / 256n),
                        observation
                    );
                    revocations.set(id, (bitmap & (1n << (note.revocationSlot % 256n))) !== 0n);
                }
            }
            if ((await reader.getBlock(observation.number)).hash !== observation.hash)
                throw new CanonicalConflict("spent observation block changed");
            await options.beforeCommit?.();
            await store.transaction(scope, (draft) => {
                signal?.throwIfAborted();
                check(draft.revision === base.revision, "wallet changed during update; retry");
                if (reset) {
                    this.reorgOperations(draft);
                    draft.notes = {};
                    draft.credits = {};
                    delete draft.observedThrough;
                    delete draft.discoveryThrough;
                    delete draft.discoveryRanges;
                    delete draft.recoveryBoundary;
                    delete draft.creditReplayFrom;
                    delete draft.creditReplayThrough;
                    delete draft.creditReplayTarget;
                    draft.creditReplayRevision = (draft.creditReplayRevision ?? 0) + 1;
                    delete draft.invalidated;
                    delete draft.unresolvedDeliveries;
                }
                mergeReceiptRecords(draft, { notes, credits, checkpoint: block });
                if (options.refreshState !== false)
                    observations.forEach((item, index) => {
                        const record = draft[item.kind][item.id];
                        if (record) {
                            mergeSpentObservation(record, {
                                spent: spent[index] ? "spent" : "unspent",
                                checkedThrough: {
                                    number: observation.number,
                                    hash: observation.hash,
                                },
                            });
                        }
                    });
                for (const [id, revoked] of revocations)
                    if (
                        draft.credits[id] &&
                        (!draft.credits[id]!.checkedThrough ||
                            draft.credits[id]!.checkedThrough!.number <= block.number)
                    )
                        draft.credits[id]!.revoked = revoked;
                const deliveries = extractDeliveryCandidates(logs, context, block.number);
                const unresolved = draft.unresolvedDeliveries ?? {};
                const key = (c: (typeof deliveries)[number]) =>
                    `${c.transactionHash}:${c.treeId}:${c.leafIndex}:${c.role}`;
                for (const candidate of deliveries)
                    if (!options.creditOnly || candidate.role !== "funds")
                        delete unresolved[key(candidate)];
                for (const candidate of decrypted.unresolved ?? [])
                    unresolved[key(candidate)] = structuredClone(candidate);
                if (Object.keys(unresolved).length) draft.unresolvedDeliveries = unresolved;
                else delete draft.unresolvedDeliveries;
                if (options.historyGeneration !== undefined)
                    draft.publicHistoryGeneration = options.historyGeneration;
                let replayChanged = false;
                if (options.queueCreditReplay) {
                    const fresh = credits.filter(
                        (record) => !base.credits[record.commitment + ":" + record.role]
                    );
                    for (const record of fresh)
                        if (
                            draft.creditReplayFrom === undefined ||
                            record.blockNumber < draft.creditReplayFrom ||
                            (draft.creditReplayThrough &&
                                record.blockNumber <= draft.creditReplayThrough.number)
                        ) {
                            draft.creditReplayFrom =
                                draft.creditReplayFrom === undefined ||
                                record.blockNumber < draft.creditReplayFrom
                                    ? record.blockNumber
                                    : draft.creditReplayFrom;
                            delete draft.creditReplayThrough;
                            replayChanged = true;
                        }
                }
                if (
                    draft.creditReplayFrom !== undefined &&
                    (options.discoveryFrom !== undefined || options.queueCreditReplay)
                ) {
                    const previousTarget =
                        draft.discoveryRanges?.at(-1)?.block ?? draft.discoveryThrough;
                    const required =
                        previousTarget && previousTarget.number > block.number
                            ? previousTarget
                            : { number: block.number, hash: block.hash };
                    if (
                        !draft.creditReplayTarget ||
                        draft.creditReplayTarget.number < required.number
                    ) {
                        draft.creditReplayTarget = { ...required };
                        replayChanged = true;
                    }
                }
                if (replayChanged)
                    draft.creditReplayRevision = (draft.creditReplayRevision ?? 0) + 1;
                if (options.creditReplayBlock)
                    draft.creditReplayThrough = { ...options.creditReplayBlock };
                if (
                    options.creditReplayComplete &&
                    options.creditReplayBlock &&
                    (!draft.creditReplayTarget ||
                        options.creditReplayBlock.number >= draft.creditReplayTarget.number)
                ) {
                    delete draft.creditReplayFrom;
                    delete draft.creditReplayThrough;
                    delete draft.creditReplayTarget;
                }
                if (options.recoveryBoundary !== undefined && draft.recoveryBoundary === undefined)
                    draft.recoveryBoundary = options.recoveryBoundary;
                if (options.discoveryFrom !== undefined) {
                    const checkpoint = options.discoveryBlock ?? {
                        number: block.number,
                        hash: block.hash,
                    };
                    const ranges =
                        draft.discoveryRanges ??
                        (draft.discoveryThrough
                            ? [
                                  {
                                      fromBlock: protocol.deployment.protocol.fromBlock,
                                      block: draft.discoveryThrough,
                                  },
                              ]
                            : []);
                    draft.discoveryRanges = mergeCoverage(ranges, {
                        fromBlock: options.discoveryFrom,
                        block: checkpoint,
                    });
                    const prefix = draft.discoveryRanges.find(
                        (range) => range.fromBlock === protocol.deployment.protocol.fromBlock
                    );
                    if (prefix) draft.discoveryThrough = { ...prefix.block };
                    else delete draft.discoveryThrough;
                }
                // Candidate-only ingestion cannot establish complete scan coverage.
                if (!draft.observedThrough || draft.observedThrough.number <= observation.number)
                    draft.observedThrough = { number: observation.number, hash: observation.hash };
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
