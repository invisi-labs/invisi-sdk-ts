import { priorityPages, accountCoverage, firstScanRange } from "./scan-order";
import { authenticatedDecryptor, type DeliveryDecryptor } from "@invisi-labs/primitives";
import type { ChainReader, CanonicalBlock } from "@invisi-labs/protocol";
import type { WalletSessionInfrastructure } from "../operations/operation-types";
import {
    walletBalances,
    type WalletScope,
    type WalletStore,
    type WalletState,
} from "../storage/state";
import { WalletUpdater, type CandidatePage } from "../sync/WalletUpdater";
import { certifyHistoryBatch } from "./authentication";
import {
    PublicHistory,
    reportProgress,
    type HistoryProgressListener,
    type AcquiredHistoryPage,
} from "./history";
import type { RefreshResult } from "../sync/refresh";

export interface AccountScanOptions {
    fromBlock?: bigint;
    toBlock?: bigint;
    reset?: boolean;
    signal?: AbortSignal;
    /** Offline scanning authenticates against retained public history; spent state stays unknown. */
    offline?: boolean;
    refreshState?: boolean;
    pageSize?: number;
    onProgress?: HistoryProgressListener;
}
export async function fenceHistory(
    history: PublicHistory,
    store: WalletStore,
    scope: WalletScope,
    summary = false
): Promise<WalletState> {
    const read = () =>
        summary && store.readSummary ? store.readSummary(scope) : store.readSnapshot(scope);
    const publicState = await history.snapshot();
    const generation = publicState.generation;
    let state = await read();
    if (
        (state.publicHistoryGeneration ?? (state.observedThrough ? 1 : generation)) !==
            generation &&
        !state.invalidated
    ) {
        await store.transaction(scope, (draft) => {
            draft.invalidated = "Public history changed; rebuild inventory from canonical data";
            for (const record of [...Object.values(draft.notes), ...Object.values(draft.credits)])
                record.spent = "unknown";
            for (const operation of Object.values(draft.operations)) {
                if (
                    ["failed", "expired"].includes(operation.status) &&
                    !(operation.payload as { externalized?: boolean } | undefined)?.externalized
                )
                    continue;
                operation.status = "reorged";
                for (const id of operation.inputs)
                    if (!draft.reservations[id]) draft.reservations[id] = operation.id;
            }
        });
        state = await read();
    }
    if (
        state.invalidated &&
        store.restoreReorgedOperations &&
        state.archiveFenceGeneration !== generation
    ) {
        await store.restoreReorgedOperations(
            scope,
            publicState.reorgFrom ?? history.scope.deploymentBlock
        );
        if ((await history.snapshot()).generation !== generation)
            throw Error("public history changed during archived journal restoration; retry");
        await store.transaction(scope, (draft) => {
            draft.archiveFenceGeneration = generation;
        });
        state = await read();
    }
    return state;
}
function localReader(history: PublicHistory, reader: ChainReader, offline: boolean): ChainReader {
    return new Proxy(reader, {
        get(target, property) {
            if (property === "getBlock")
                return async (number: bigint) => {
                    const page = await history.options.store.pageAt(history.scope, number);
                    const block = page?.headers.find((h) => h.number === number);
                    if (!block) {
                        if (!offline) return target.getBlock(number);
                        throw Error("public block unavailable; synchronize the missing range");
                    }
                    return structuredClone(block);
                };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
function publicProvider(options: WalletSessionInfrastructure, offline: boolean) {
    const provider = options.protocolRpc!;
    if (!offline) return provider;
    return new Proxy(provider, {
        get(target, property) {
            if (property === "getMembership")
                return async () => {
                    throw Error("recovered Credit membership unavailable offline; retry online");
                };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}
export async function scanAccount(
    history: PublicHistory,
    options: WalletSessionInfrastructure,
    scope: WalletScope,
    decryptor: DeliveryDecryptor,
    settings: AccountScanOptions = {},
    staged?: AcquiredHistoryPage
): Promise<RefreshResult> {
    const store = options.store;
    if (!store || !options.chainReader || !options.protocolRpc)
        throw Error("account scan requires store, Chain RPC and Protocol RPC");
    const base = await fenceHistory(history, store, scope),
        publicState = await history.snapshot();
    if (base.invalidated && !settings.reset)
        throw Error("wallet state is invalidated; rebuild required");
    const target =
        settings.toBlock ??
        publicState.indexedHead?.number ??
        publicState.coverage?.at(-1)?.block.number ??
        publicState.through?.number;
    if (target === undefined) throw Error("public history has no complete checkpoint");
    if (
        settings.reset &&
        settings.fromBlock !== undefined &&
        settings.fromBlock !== history.scope.deploymentBlock
    )
        throw Error("rebuild must start at protocol deployment");
    const lower = settings.fromBlock ?? history.scope.deploymentBlock;
    const size = settings.pageSize ?? 100;
    if (!Number.isInteger(size) || size < 1 || size > 256)
        throw Error("public page size must be 1..256");
    if (lower < history.scope.deploymentBlock || target < history.scope.deploymentBlock)
        throw Error("account scan precedes deployment");
    const boundary =
        (!settings.reset ? base.recoveryBoundary : undefined) ??
        firstScanRange(
            base,
            publicState,
            history.scope.deploymentBlock,
            lower,
            target,
            size,
            !!settings.reset
        )?.fromBlock ??
        lower;
    const reader = localReader(history, options.chainReader!, !!settings.offline);
    const receiving = options.wallet.getReceivingAddress();
    const active = authenticatedDecryptor(options.wallet, decryptor);
    const viewing = {
        ...active,
        async detectCandidates(...args: Parameters<typeof active.detectCandidates>) {
            reportProgress(settings.onProgress, { phase: "detect", state: "processing", target });
            return active.detectCandidates(...args);
        },
        async decryptNote(...args: Parameters<typeof active.decryptNote>) {
            reportProgress(settings.onProgress, { phase: "decrypt", state: "processing", target });
            return active.decryptNote(...args);
        },
        async decryptCredit(...args: Parameters<typeof active.decryptCredit>) {
            reportProgress(settings.onProgress, { phase: "decrypt", state: "processing", target });
            return active.decryptCredit(...args);
        },
    };
    const updater = new WalletUpdater({
        protocol: options.protocol,
        scope,
        store,
        reader,
        protocolRpc: publicProvider(options, !!settings.offline),
        viewing,
        ...(receiving.kind === "long" ? { receivingKeys: receiving.getReceivingKeys() } : {}),
    });
    let notes = 0,
        credits = 0,
        first = true;
    const beforeCommit = async (block: CanonicalBlock) => {
        settings.signal?.throwIfAborted();
        if ((await history.snapshot()).generation !== publicState.generation)
            throw Error("public history generation changed during account scan");
        if (
            !settings.offline &&
            (await options.chainReader!.getBlock(block.number)).hash !== block.hash
        ) {
            await history.validateCanonical();
            await fenceHistory(history, store, scope);
            throw Error("canonical history changed during account scan; synchronize again");
        }
        reportProgress(settings.onProgress, { phase: "commit", state: "processing", target });
    };
    for await (const { page, direction } of priorityPages(
        history,
        store,
        scope,
        {
            lower,
            target,
            size,
            ...(settings.reset ? { reset: true } : {}),
            ...(settings.offline ? { offline: true } : {}),
            ...(settings.signal ? { signal: settings.signal } : {}),
            ...(settings.onProgress
                ? { onProgress: (p) => reportProgress(settings.onProgress, { ...p, target }) }
                : {}),
        },
        staged
    )) {
        settings.signal?.throwIfAborted();
        const batch: CandidatePage = {
            context: options.protocol.context,
            block: await reader.getBlock(target),
            transactionHashes: page.receipts.map((r) => r.transactionHash),
        };
        certifyHistoryBatch(batch, page);
        reportProgress(settings.onProgress, { phase: "validate", state: "processing", target });
        const observation = (await history.snapshot()).knownHead ?? batch.block;
        const result = await updater.applyUpdates(batch, {
            ...(settings.signal ? { signal: settings.signal } : {}),
            ...(settings.reset && first ? { reset: true } : {}),
            refreshState: !settings.offline && settings.refreshState !== false,
            observationBlock: settings.offline ? batch.block : observation,
            discoveryFrom: page.fromBlock,
            recoveryBoundary: boundary,
            discoveryBlock: { number: page.block.number, hash: page.block.hash },
            queueCreditReplay: direction === "backward" || !base.discoveryThrough,

            historyGeneration: publicState.generation,
            beforeCommit: () => beforeCommit(settings.offline ? batch.block : observation),
        });
        notes += result.notes;
        credits += result.credits;
        first = false;
        const state = await store.readSnapshot(scope);
        const latestPublic = await history.snapshot();
        reportProgress(settings.onProgress, {
            phase: "commit",
            state: "committed",
            target,
            direction,
            accountRanges: accountCoverage(state, history.scope.deploymentBlock),
            ...(latestPublic.through ? { publicThrough: latestPublic.through } : {}),
            ...(state.discoveryThrough ? { accountThrough: state.discoveryThrough } : {}),
        });
    }
    const block = await reader.getBlock(target);
    // A completely empty/new range still refreshes existing nullifiers and Credit bitmaps.
    if (first && !settings.offline && settings.refreshState !== false) {
        const page = {
            fromBlock: target,
            block,
            headers: [block],
            receipts: [],
            logs: [],
            verifiedPositions: [],
        };
        const batch: CandidatePage = {
            context: options.protocol.context,
            block,
            transactionHashes: [],
        };
        certifyHistoryBatch(batch, page);
        await updater.applyUpdates(batch, {
            ...(settings.signal ? { signal: settings.signal } : {}),
            historyGeneration: publicState.generation,
            beforeCommit: () => beforeCommit(block),
        });
    }
    if (!settings.offline && lower <= target) {
        const replay = await replayCredits(history, options, scope, decryptor, target, settings);
        credits += replay;
    }
    return { block, notes, credits, balances: walletBalances(await store.readSnapshot(scope)) };
}

// Credit successors can depend on older private parents; finish these transitions in chain order.
async function replayCredits(
    history: PublicHistory,
    options: WalletSessionInfrastructure,
    scope: WalletScope,
    decryptor: DeliveryDecryptor,
    target: bigint,
    settings: AccountScanOptions
): Promise<number> {
    const store = options.store!,
        state = await store.readSnapshot(scope);
    if (state.creditReplayFrom === undefined) return 0;
    const generation = (await history.snapshot()).generation;
    const requiredRange = accountCoverage(state, history.scope.deploymentBlock).at(-1)?.block;
    const required =
        state.creditReplayTarget &&
        (!requiredRange || state.creditReplayTarget.number > requiredRange.number)
            ? state.creditReplayTarget.number
            : (requiredRange?.number ?? target);
    const replayRevision = state.creditReplayRevision ?? 0;
    const start = state.creditReplayThrough
        ? state.creditReplayThrough.number + 1n
        : state.creditReplayFrom;
    if (start > target) return 0;
    const reader = localReader(history, options.chainReader!, false),
        block = await reader.getBlock(target),
        receiving = options.wallet.getReceivingAddress();
    const updater = new WalletUpdater({
        protocol: options.protocol,
        scope,
        store,
        reader,
        protocolRpc: options.protocolRpc!,
        viewing: authenticatedDecryptor(options.wallet, decryptor),
        ...(receiving.kind === "long" ? { receivingKeys: receiving.getReceivingKeys() } : {}),
    });
    let credits = 0;
    for await (const page of history.pages(start, target, {
        pageSize: settings.pageSize ?? 100,
        ...(settings.signal ? { signal: settings.signal } : {}),
        ...(settings.onProgress
            ? {
                  onProgress: (p) =>
                      reportProgress(settings.onProgress, {
                          ...p,
                          target,
                          direction: "credit-recovery",
                      }),
              }
            : {}),
    })) {
        settings.signal?.throwIfAborted();
        const batch: CandidatePage = {
            context: options.protocol.context,
            block,
            transactionHashes: page.receipts.map((r) => r.transactionHash),
        };
        certifyHistoryBatch(batch, page);
        const result = await updater.applyUpdates(batch, {
            creditOnly: true,
            creditReplayBlock: { number: page.block.number, hash: page.block.hash },
            creditReplayComplete: page.block.number >= required,
            creditReplayRevision: replayRevision,
            refreshState: settings.refreshState !== false,
            historyGeneration: generation,
            ...(settings.signal ? { signal: settings.signal } : {}),
            beforeCommit: async () => {
                settings.signal?.throwIfAborted();
                if ((await history.snapshot()).generation !== generation)
                    throw Error("public history generation changed during Credit recovery");
                if ((await options.chainReader!.getBlock(target)).hash !== block.hash)
                    throw Error("canonical history changed during Credit recovery");
            },
        });
        credits += result.credits;
        reportProgress(settings.onProgress, {
            phase: "commit",
            state: "committed",
            target,
            direction: "credit-recovery",
        });
    }
    return credits;
}

/** Retries retained ambiguous candidates without changing the account discovery cursor. */
export async function retryUnresolved(
    history: PublicHistory,
    options: WalletSessionInfrastructure,
    scope: WalletScope,
    decryptor: DeliveryDecryptor,
    settings: Omit<AccountScanOptions, "fromBlock" | "toBlock" | "reset"> = {}
): Promise<RefreshResult> {
    const state = await fenceHistory(history, options.store!, scope);
    if (state.invalidated) throw Error("wallet state is invalidated; rebuild required");
    const snapshot = await history.snapshot();
    const target = snapshot.indexedHead ?? snapshot.coverage?.at(-1)?.block ?? snapshot.through;
    if (!target) throw Error("public history has no indexed checkpoint");
    const reader = localReader(history, options.chainReader!, !!settings.offline);
    const receiving = options.wallet.getReceivingAddress();
    const updater = new WalletUpdater({
        protocol: options.protocol,
        scope,
        store: options.store!,
        reader,
        protocolRpc: publicProvider(options, !!settings.offline),
        viewing: authenticatedDecryptor(options.wallet, decryptor),
        ...(receiving.kind === "long" ? { receivingKeys: receiving.getReceivingKeys() } : {}),
    });
    const ranges = new Set<bigint>();
    for (const candidate of Object.values(state.unresolvedDeliveries ?? {})) {
        const reference = snapshot.pages.find(
            (p) => p.fromBlock <= candidate.blockNumber && p.block.number >= candidate.blockNumber
        );
        if (!reference)
            throw Error("unresolved candidate history unavailable; synchronize the missing range");
        ranges.add(reference.fromBlock);
    }
    let notes = 0,
        credits = 0;
    for (const from of ranges) {
        settings.signal?.throwIfAborted();
        const page = await history.options.store.pageAt(history.scope, from);
        if (!page) throw Error("unresolved candidate history unavailable");
        const batch: CandidatePage = {
            context: options.protocol.context,
            block: target,
            transactionHashes: page.receipts.map((r) => r.transactionHash),
        };
        certifyHistoryBatch(batch, { ...page, block: target });
        const result = await updater.applyUpdates(batch, {
            ...(settings.signal ? { signal: settings.signal } : {}),
            queueCreditReplay: true,
            refreshState: !settings.offline && settings.refreshState !== false,
            historyGeneration: snapshot.generation,
            beforeCommit: async () => {
                settings.signal?.throwIfAborted();
                if ((await history.snapshot()).generation !== snapshot.generation)
                    throw Error("public history generation changed during retry");
                if (
                    !settings.offline &&
                    (await options.chainReader!.getBlock(target.number)).hash !== target.hash
                ) {
                    await history.validateCanonical();
                    await fenceHistory(history, options.store!, scope);
                    throw Error("canonical history changed during retry");
                }
            },
        });
        notes += result.notes;
        credits += result.credits;
        reportProgress(settings.onProgress, {
            phase: "commit",
            state: "committed",
            target: target.number,
            publicThrough: target,
            ...(state.discoveryThrough ? { accountThrough: state.discoveryThrough } : {}),
        });
    }
    if (!settings.offline)
        credits += await replayCredits(history, options, scope, decryptor, target.number, settings);
    return {
        block: target,
        notes,
        credits,
        balances: walletBalances(await options.store!.readSnapshot(scope)),
    };
}
