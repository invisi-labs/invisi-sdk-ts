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
    fromBlock: bigint;
    /** Defaults to the Protocol RPC's indexed head, independently checked against Chain RPC. */
    toBlock?: bigint;
    /** Explicit permission to delegate detection; never provide a viewing or spending key. */
    detectionKey?: Uint8Array;
    /** Defaults to MAX_UPDATE_BLOCKS (10000 blocks) per service request. Reduce this on high-volume deployments. */
    pageSize?: number;
    signal?: AbortSignal;
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
    try {
        signal?.throwIfAborted();
        if (typeof options.fromBlock !== "bigint" || options.fromBlock < runtime.fromBlock)
            throw new Error("refresh range precedes deployment");
        const pageSize = options.pageSize ?? MAX_UPDATE_BLOCKS;
        if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_UPDATE_BLOCKS)
            throw new Error(`refresh page size must be 1..${MAX_UPDATE_BLOCKS}`);
        const status = await runtime.provider.getStatus(runtime.context, {
            ...(signal ? { signal } : {}),
        });
        if (!status.indexedHead) throw new Error("Protocol RPC has not indexed any blocks");
        const toBlock = options.toBlock ?? status.indexedHead.number;
        if (
            typeof toBlock !== "bigint" ||
            toBlock < options.fromBlock ||
            toBlock > status.indexedHead.number
        )
            throw new Error("refresh range is outside indexed history");
        const target = await runtime.reader.getBlock(toBlock);
        if (target.number !== toBlock)
            throw new Error("Chain RPC returned the wrong refresh anchor");
        let result: RefreshResult | undefined;
        let notes = 0;
        let credits = 0;
        for (let from = options.fromBlock; from <= toBlock; from += BigInt(pageSize)) {
            signal?.throwIfAborted();
            const end = from + BigInt(pageSize) - 1n;
            const page = await runtime.provider.getUpdates(runtime.context, {
                fromBlock: from,
                toBlock: end < toBlock ? end : toBlock,
                ...(options.detectionKey ? { detectionKey: options.detectionKey } : {}),
                ...(signal ? { signal } : {}),
            });
            if (page.block.number !== (end < toBlock ? end : toBlock))
                throw new Error("Protocol RPC returned the wrong page anchor");
            signal?.throwIfAborted();
            // Empty candidates are not proof of an unchanged spent set (for example,
            // a full payout has no outputs). Retain one final state refresh when all
            // pages are empty; previous applications already observed this target.
            if (
                page.transactionHashes.length === 0 &&
                (result || from + BigInt(pageSize) <= toBlock)
            )
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
    } finally {
        // The caller retains its own key; only this request's copied key is cleared.
        options.detectionKey?.fill(0);
    }
}
