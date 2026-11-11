import type {
    CanonicalBlock,
    ChainReader,
    DeploymentContext,
    ProtocolDataProvider,
} from "@invisi-labs/protocol";
import { MAX_UPDATE_BLOCKS } from "@invisi-labs/rpc";
import type { BalanceSnapshot } from "../storage/state";
import type { ApplyPageOptions, CandidatePage } from "./WalletUpdater";

export interface RefreshResult {
    block: CanonicalBlock;
    notes: number;
    credits: number;
    balances: BalanceSnapshot[];
}

export interface RefreshOptions {
    /** Explicit history range; retain the returned block to request the next page later. */
    fromBlock?: bigint;
    /** Defaults to the Protocol RPC's indexed head, independently checked against Chain RPC. */
    toBlock?: bigint;
    /** WalletSession defaults to 100, at most 256; low-level refreshWallet permits MAX_UPDATE_BLOCKS. */
    pageSize?: number;
    signal?: AbortSignal;
    onProgress?: import("../public-history/history").HistoryProgressListener;
    refreshState?: boolean;
    offline?: boolean;
    /** Rebuild private inventory from these pages while retaining uncertain operations. */
    reset?: boolean;
}

export async function refreshWallet(
    runtime: {
        provider: ProtocolDataProvider;
        reader: Pick<ChainReader, "getBlock">;
        context: DeploymentContext;
        fromBlock: bigint;
        apply(batch: CandidatePage, options: ApplyPageOptions): Promise<RefreshResult>;
    },
    options: RefreshOptions
): Promise<RefreshResult> {
    const { signal } = options;
    const fromBlock = options.fromBlock ?? runtime.fromBlock;
    signal?.throwIfAborted();
    if (typeof fromBlock !== "bigint" || fromBlock < runtime.fromBlock)
        throw new Error("refresh range precedes deployment");
    const pageSize = options.pageSize ?? MAX_UPDATE_BLOCKS;
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_UPDATE_BLOCKS)
        throw new Error(`refresh page size must be 1..${MAX_UPDATE_BLOCKS}`);
    const status = await runtime.provider.getStatus(runtime.context, {
        ...(signal ? { signal } : {}),
    });
    if (!status.indexedHead) throw new Error("Protocol RPC has not indexed any blocks");
    const toBlock = options.toBlock ?? status.indexedHead.number;
    if (typeof toBlock !== "bigint" || toBlock < fromBlock || toBlock > status.indexedHead.number)
        throw new Error("refresh range is outside indexed history");
    const target = await runtime.reader.getBlock(toBlock);
    if (target.number !== toBlock) throw new Error("Chain RPC returned the wrong refresh anchor");
    let result: RefreshResult | undefined;
    let notes = 0;
    let credits = 0;
    for (let from = fromBlock; from <= toBlock; from += BigInt(pageSize)) {
        signal?.throwIfAborted();
        const end = from + BigInt(pageSize) - 1n;
        const range = {
            fromBlock: from,
            toBlock: end < toBlock ? end : toBlock,
            ...(signal ? { signal } : {}),
        };
        const [notePage, creditPage] = await Promise.all([
            runtime.provider.getNoteUpdates(runtime.context, range),
            runtime.provider.getCreditTransitions(runtime.context, range),
        ]);
        if (
            creditPage.block.hash !== notePage.block.hash ||
            creditPage.block.number !== notePage.block.number
        )
            throw Error("Protocol RPC business query anchors differ");
        const page = {
            block: notePage.block,
            transactionHashes: [
                ...new Set([
                    ...notePage.notes.map((n) => n.transactionHash),
                    ...creditPage.transitions.map((n) => n.transactionHash),
                ]),
            ],
        };
        if (page.block.number !== (end < toBlock ? end : toBlock))
            throw new Error("Protocol RPC returned the wrong page anchor");
        signal?.throwIfAborted();
        // Empty candidates are not proof of an unchanged spent set (for example,
        // a full payout has no outputs). Retain one final state refresh when all
        // pages are empty; previous applications already observed this target.
        if (page.transactionHashes.length === 0 && (result || from + BigInt(pageSize) <= toBlock))
            continue;
        const firstApplication = result === undefined;
        result = await runtime.apply(
            {
                context: runtime.context,
                transactionHashes: page.transactionHashes,
                block: target,
            },
            {
                ...(signal ? { signal } : {}),
                ...(firstApplication && options.reset ? { reset: true } : {}),
            }
        );
        notes += result.notes;
        credits += result.credits;
    }
    return { ...result!, notes, credits };
}
