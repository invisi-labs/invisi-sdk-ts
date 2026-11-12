import {
    createPreparationCapture,
    registerPreparationHistoryCapture,
} from "../sync/preparation-capture";
import { highestGap } from "./coverage";
import type { ChainReader, CanonicalBlock, ProtocolDataProvider } from "@invisi-labs/protocol";
import type { Protocol } from "@invisi-labs/rpc";
import {
    extractDeliveryCandidates,
    readProtocolLogs,
    verifyMembership,
} from "@invisi-labs/sdk/session-support";
import {
    PublicHistoryStore,
    PublicHistoryPageError,
    historyPosition,
    publicScopeKey,
    type PublicHistoryScope,
    type PublicHistoryPage,
} from "./store";
export interface HistoryProgress {
    phase: "download" | "detect" | "decrypt" | "validate" | "commit" | "refresh";
    state: "processing" | "committed";
    target: bigint;
    publicThrough?: CanonicalBlock;
    accountThrough?: { number: bigint; hash: `0x${string}` };
    direction?: "forward" | "backward" | "credit-recovery";
    accountRanges?: import("./coverage").CoverageRange<import("../storage/state").Checkpoint>[];
}
export type HistoryProgressListener = (progress: HistoryProgress) => void;
export function reportProgress(
    listener: HistoryProgressListener | undefined,
    progress: HistoryProgress
): void {
    try {
        listener?.(structuredClone(progress));
    } catch {
        /* Observers cannot undo a committed batch. */
    }
}
export interface AcquiredHistoryPage {
    generation: number;
    page: PublicHistoryPage;
}
export interface PublicSyncOptions {
    fromBlock?: bigint;
    toBlock?: bigint;
    pageSize?: number;
    signal?: AbortSignal;
    onProgress?: HistoryProgressListener;
}
function subscribe<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return task;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("history request aborted"));
        signal.addEventListener("abort", abort, { once: true });
        task.then(
            (value) => {
                signal.removeEventListener("abort", abort);
                if (!signal.aborted) resolve(value);
            },
            (error) => {
                signal.removeEventListener("abort", abort);
                reject(error);
            }
        );
    });
}
export function historyScope(protocol: Protocol): PublicHistoryScope {
    return {
        ...protocol.context,
        runtimeCodeHash: protocol.deployment.protocol.runtimeCodeHash,
        deploymentBlock: protocol.deployment.protocol.fromBlock,
    };
}
interface Coordinator {
    queue: Promise<unknown>;
    listeners: Set<HistoryProgressListener>;
}
const coordinators = new WeakMap<PublicHistoryStore, Map<string, Coordinator>>();
/** One coordinator is shared by all accounts using the same public store/deployment. */
export class PublicHistory {
    readonly scope: PublicHistoryScope;
    readonly key: string;
    readonly #preparationCapture = createPreparationCapture();
    #coordinator: Coordinator;
    constructor(
        readonly options: {
            store: PublicHistoryStore;
            protocol: Protocol;
            reader: ChainReader;
            protocolRpc: ProtocolDataProvider;
        }
    ) {
        registerPreparationHistoryCapture(this, this.#preparationCapture);
        this.scope = Object.freeze(historyScope(options.protocol));
        this.key = publicScopeKey(this.scope);
        let scopes = coordinators.get(options.store);
        if (!scopes) {
            scopes = new Map();
            coordinators.set(options.store, scopes);
        }
        let coordinator = scopes.get(this.key);
        if (!coordinator) {
            coordinator = { queue: Promise.resolve(), listeners: new Set() };
            scopes.set(this.key, coordinator);
        }
        this.#coordinator = coordinator;
    }
    snapshot() {
        return this.options.store.snapshot(this.scope);
    }
    async synchronize(options: PublicSyncOptions = {}): Promise<CanonicalBlock> {
        options.signal?.throwIfAborted();
        const listener = options.onProgress
            ? (progress: HistoryProgress) => options.onProgress!(progress)
            : undefined;
        if (listener) this.#coordinator.listeners.add(listener);
        // A subscriber owns its wait, not the shared download's cancellation signal.
        const { signal: _signal, onProgress: _progress, ...range } = options;
        const task = this.#coordinator.queue.then(() =>
            range.fromBlock === undefined
                ? this.synchronizeResume(range)
                : this.synchronizeRange(range)
        );
        this.#coordinator.queue = task.catch(() => {});
        try {
            return await subscribe(task, options.signal);
        } finally {
            if (listener) this.#coordinator.listeners.delete(listener);
        }
    }
    /** A page can be consumed even when its old block range is not retained by the cache. */
    async acquirePage(
        from: bigint,
        to: bigint,
        options: Omit<PublicSyncOptions, "fromBlock" | "toBlock"> = {}
    ): Promise<AcquiredHistoryPage> {
        options.signal?.throwIfAborted();
        const listener = options.onProgress
            ? (progress: HistoryProgress) => options.onProgress!(progress)
            : undefined;
        if (listener) this.#coordinator.listeners.add(listener);
        const { signal: _signal, onProgress: _progress, ...settings } = options;
        const task = this.#coordinator.queue.then(async () => {
            let acquired: AcquiredHistoryPage | undefined;
            await this.synchronizeRange(
                { ...settings, fromBlock: from, toBlock: to },
                (page, generation) => {
                    acquired = { page, generation };
                }
            );
            if (!acquired) throw Error("requested history page unavailable");
            return acquired;
        });
        this.#coordinator.queue = task.catch(() => {});
        try {
            return await subscribe(task, options.signal);
        } finally {
            if (listener) this.#coordinator.listeners.delete(listener);
        }
    }
    private report(
        phase: HistoryProgress["phase"],
        state: HistoryProgress["state"],
        target: bigint,
        publicThrough?: CanonicalBlock
    ) {
        for (const listener of this.#coordinator.listeners)
            reportProgress(listener, {
                phase,
                state,
                target,
                ...(publicThrough ? { publicThrough } : {}),
            });
    }
    async validateCanonical() {
        const task = this.#coordinator.queue.then(() => this.reconcile());
        this.#coordinator.queue = task.catch(() => {});
        return task;
    }
    private async reconcile() {
        const { reader, store } = this.options,
            before = await this.snapshot();
        const anchors = [
            ...(before.through ? [before.through] : []),
            ...(before.coverage ?? []).map((range) => range.block),
            ...before.pages
                .filter((p, i) => before.pages[i + 1]?.fromBlock !== p.block.number + 1n)
                .map((p) => p.block),
        ];
        let changed = false;
        for (const anchor of anchors) {
            if ((await reader.getBlock(anchor.number)).hash !== anchor.hash) {
                changed = true;
                break;
            }
        }
        if (!changed) return before;
        let ancestor = this.scope.deploymentBlock - 1n;
        let ancestorBlock: CanonicalBlock | undefined;
        outer: for (const reference of [...before.pages].reverse()) {
            let page: PublicHistoryPage;
            try {
                page = await store.read(reference);
            } catch (error) {
                if (error instanceof PublicHistoryPageError) {
                    await store.discard(this.scope, reference);
                    continue;
                }
                throw error;
            }
            for (const block of [...page.headers].reverse()) {
                if ((await reader.getBlock(block.number)).hash === block.hash) {
                    ancestor = block.number;
                    ancestorBlock = block;
                    break outer;
                }
            }
        }
        return store.rewind(this.scope, ancestor, ancestorBlock);
    }
    private async observeHead(status: import("@invisi-labs/protocol").ProtocolDataStatus) {
        if (!status.indexedHead) return;
        const reader = this.options.reader,
            indexed = await reader.getBlock(status.indexedHead.number);
        if (indexed.hash !== status.indexedHead.hash)
            throw Error("Protocol RPC indexed head is not canonical");
        const height =
            typeof reader.getLatestBlockNumber === "function"
                ? await reader.getLatestBlockNumber()
                : indexed.number;
        const known = height > indexed.number ? await reader.getBlock(height) : indexed;
        await this.options.store.noteHead(this.scope, indexed, known);
        if (this.#preparationCapture) this.#preparationCapture.anchor = structuredClone(known);
    }
    private async synchronizeResume(
        settings: Omit<PublicSyncOptions, "signal" | "onProgress">
    ): Promise<CanonicalBlock> {
        const size = settings.pageSize ?? 100;
        if (!Number.isInteger(size) || size < 1 || size > 256)
            throw Error("public page size must be 1..256");
        await this.options.protocol.validateDeployment(
            this.#preparationCapture?.reader(this.options.reader) ?? this.options.reader
        );
        const before = await this.reconcile();
        const status = await this.options.protocolRpc.getStatus(this.options.protocol.context);
        await this.observeHead(status);
        const target = settings.toBlock ?? status.indexedHead?.number;
        if (
            target === undefined ||
            !status.indexedHead ||
            target < this.scope.deploymentBlock ||
            target > status.indexedHead.number
        )
            throw Error("invalid public history range");
        const block = await this.options.reader.getBlock(target);
        const highest = before.coverage?.at(-1)?.block.number ?? before.pages.at(-1)?.block.number;
        const start =
            highest === undefined
                ? target - BigInt(size) + 1n > this.scope.deploymentBlock
                    ? target - BigInt(size) + 1n
                    : this.scope.deploymentBlock
                : highest + 1n;
        if (start <= target)
            await this.synchronizeRange({ ...settings, fromBlock: start, toBlock: target });
        while (true) {
            const state = await this.snapshot();
            const gap = highestGap(state.coverage ?? [], this.scope.deploymentBlock, target);
            if (!gap) break;
            const from =
                gap.toBlock - BigInt(size) + 1n > gap.fromBlock
                    ? gap.toBlock - BigInt(size) + 1n
                    : gap.fromBlock;
            await this.synchronizeRange({ ...settings, fromBlock: from, toBlock: gap.toBlock });
        }
        if ((await this.options.reader.getBlock(target)).hash !== block.hash)
            throw Error("canonical history changed during synchronization");
        return block;
    }
    private async synchronizeRange(
        settings: Omit<PublicSyncOptions, "signal" | "onProgress">,
        capture?: (page: PublicHistoryPage, generation: number) => void
    ) {
        const { protocol, protocolRpc, store } = this.options;
        const reader = this.#preparationCapture?.reader(this.options.reader) ?? this.options.reader;
        const size = settings.pageSize ?? 100;
        if (!Number.isSafeInteger(size) || size < 1 || size > 256)
            throw Error("public page size must be 1..256");
        await protocol.validateDeployment(reader);
        const original = await this.snapshot();
        let snapshot = await this.reconcile();
        const status = await protocolRpc.getStatus(protocol.context);
        await this.observeHead(status);
        if (!status.indexedHead) throw Error("Protocol RPC has not indexed history");
        const target = settings.toBlock ?? status.indexedHead.number;
        let cursor =
            settings.fromBlock ??
            (snapshot.through ? snapshot.through.number + 1n : this.scope.deploymentBlock);
        if (snapshot.generation !== original.generation)
            cursor =
                cursor < (snapshot.through?.number ?? this.scope.deploymentBlock - 1n) + 1n
                    ? cursor
                    : (snapshot.through?.number ?? this.scope.deploymentBlock - 1n) + 1n;
        if (
            typeof cursor !== "bigint" ||
            typeof target !== "bigint" ||
            cursor < this.scope.deploymentBlock ||
            target > status.indexedHead.number
        )
            throw Error("invalid public history range");
        if (target < this.scope.deploymentBlock) throw Error("public target precedes deployment");
        const targetBlock = await reader.getBlock(target);
        if (targetBlock.number !== target) throw Error("wrong public history target");
        while (cursor <= target) {
            snapshot = await this.snapshot();
            const cached = snapshot.pages.find(
                (p) => p.fromBlock <= cursor && p.block.number >= cursor
            );
            if (cached) {
                try {
                    const page = await store.read(cached);
                    if (capture) {
                        capture(page, snapshot.generation);
                        break;
                    }
                    cursor = cached.block.number + 1n;
                    continue;
                } catch (error) {
                    if (!(error instanceof PublicHistoryPageError)) throw error;
                    await store.discard(this.scope, cached);
                    continue;
                }
            }
            let end = cursor + BigInt(size) - 1n;
            if (end > target) end = target;
            const next = snapshot.pages.find((p) => p.fromBlock > cursor);
            if (next && next.fromBlock <= end) end = next.fromBlock - 1n;
            this.report("download", "processing", target, snapshot.through);
            const range = { fromBlock: cursor, toBlock: end };
            const [notes, credits] = await Promise.all([
                protocolRpc.getNoteUpdates(protocol.context, range),
                protocolRpc.getCreditTransitions(protocol.context, range),
            ]);
            const headers: CanonicalBlock[] = [];
            for (let n = cursor; n <= end; n++) {
                const header = await reader.getBlock(n);
                if (
                    header.number !== n ||
                    (headers.length && header.parentHash !== headers.at(-1)!.hash)
                )
                    throw Error("noncanonical public history headers");
                headers.push(header);
            }
            const block = headers.at(-1)!;
            if (
                notes.block.number !== end ||
                credits.block.number !== end ||
                notes.block.hash !== block.hash ||
                credits.block.hash !== block.hash
            )
                throw Error("Protocol RPC business query anchors differ");
            const hashes = [
                ...new Set([
                    ...notes.notes.map((n) => n.transactionHash),
                    ...credits.transitions.map((c) => c.transactionHash),
                ]),
            ];
            if (hashes.length > 2048)
                throw Error("public history page too dense; reduce page size");
            const receipts: PublicHistoryPage["receipts"] = [];
            this.report("validate", "processing", target, snapshot.through);
            for (const hash of hashes) {
                const receipt = await reader.getReceipt(hash);
                if (
                    !receipt ||
                    receipt.status !== "success" ||
                    receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
                    receipt.block.number < cursor ||
                    receipt.block.number > end ||
                    headers[Number(receipt.block.number - cursor)]!.hash !== receipt.block.hash
                )
                    throw Error("invalid canonical public receipt");
                receipts.push(receipt);
            }
            const logs = receipts.flatMap((r) =>
                readProtocolLogs(r, protocol.context.protocolAddress)
            );
            const candidates = extractDeliveryCandidates(logs, protocol.context, end);
            const verifiedPositions = new Set<string>();
            for (const candidate of candidates) {
                const key = historyPosition(
                    candidate.treeId,
                    candidate.leafIndex,
                    candidate.commitment
                );
                if (verifiedPositions.has(key)) continue;
                const proof = await protocolRpc.getMembership(protocol.context, candidate, block);
                await verifyMembership(
                    reader,
                    { ...protocol.context, tokenAddress: candidate.tokenAddress },
                    block,
                    candidate,
                    proof
                );
                this.#preparationCapture?.rememberMembership(candidate, proof);
                verifiedPositions.add(key);
            }
            if ((await reader.getBlock(end)).hash !== block.hash)
                throw Error("canonical history changed during synchronization");
            const page = {
                fromBlock: cursor,
                block,
                headers,
                receipts,
                logs,
                verifiedPositions: [...verifiedPositions],
            };
            snapshot = await store.append(this.scope, page, snapshot.generation);
            this.report("commit", "committed", target, snapshot.through);
            if (capture) {
                capture(page, snapshot.generation);
                break;
            }
            cursor = end + 1n;
        }
        if ((await reader.getBlock(target)).hash !== targetBlock.hash)
            throw Error("canonical history changed during synchronization");
        return targetBlock;
    }
    /** Offline reads never download missing/evicted pages. */
    async *pages(
        from: bigint,
        to: bigint,
        refill?: { pageSize?: number; signal?: AbortSignal; onProgress?: HistoryProgressListener },
        staged?: AcquiredHistoryPage
    ): AsyncGenerator<PublicHistoryPage> {
        let cursor = from;
        const generation = (await this.snapshot()).generation;
        while (cursor <= to) {
            if ((await this.snapshot()).generation !== generation)
                throw Error("public history generation changed");
            let page = await this.options.store.pageAt(this.scope, cursor);
            if (
                !page &&
                staged?.generation === generation &&
                staged.page.fromBlock <= cursor &&
                staged.page.block.number >= cursor
            )
                page = staged.page;
            staged = undefined;
            if (!page && refill) {
                const size = refill.pageSize ?? 100;
                const end = cursor + BigInt(size) - 1n;
                const acquired = await this.acquirePage(cursor, end < to ? end : to, {
                    pageSize: size,
                    ...(refill.signal ? { signal: refill.signal } : {}),
                    ...(refill.onProgress ? { onProgress: refill.onProgress } : {}),
                });
                if ((await this.snapshot()).generation !== generation)
                    throw Error("public history generation changed");
                if (acquired.generation !== generation)
                    throw Error("public history generation changed");
                page = acquired.page;
            }
            if (!page)
                throw Error(
                    `public history unavailable at ${cursor}; synchronize the missing range`
                );
            const end = page.block.number < to ? page.block.number : to;
            const block = page.headers.find((h) => h.number === end)!;
            yield {
                ...page,
                fromBlock: cursor,
                block,
                headers: page.headers.filter((h) => h.number >= cursor && h.number <= end),
                receipts: page.receipts.filter(
                    (r) => r.block.number >= cursor && r.block.number <= end
                ),
                logs: page.logs.filter(
                    (l) => l.blockNumber != null && l.blockNumber >= cursor && l.blockNumber <= end
                ),
            };
            cursor = end + 1n;
        }
    }
    async *pagesReverse(
        from: bigint,
        to: bigint,
        refill?: { pageSize?: number; signal?: AbortSignal; onProgress?: HistoryProgressListener },
        staged?: AcquiredHistoryPage
    ): AsyncGenerator<PublicHistoryPage> {
        let cursor = to;
        const generation = (await this.snapshot()).generation;
        while (cursor >= from) {
            const snapshot = await this.snapshot();
            if (snapshot.generation !== generation)
                throw Error("public history generation changed");
            let page = await this.options.store.pageAt(this.scope, cursor);
            if (
                !page &&
                staged?.generation === generation &&
                staged.page.fromBlock <= cursor &&
                staged.page.block.number >= cursor
            )
                page = staged.page;
            staged = undefined;
            if (!page && refill) {
                const size = refill.pageSize ?? 100;
                let start = cursor - BigInt(size) + 1n > from ? cursor - BigInt(size) + 1n : from;
                const older = snapshot.pages
                    .filter((p) => p.block.number < cursor && p.block.number >= start)
                    .at(-1);
                if (older) start = older.block.number + 1n;
                const acquired = await this.acquirePage(start, cursor, {
                    pageSize: Number(cursor - start + 1n),
                    ...(refill.signal ? { signal: refill.signal } : {}),
                    ...(refill.onProgress ? { onProgress: refill.onProgress } : {}),
                });
                if (acquired.generation !== generation)
                    throw Error("public history generation changed");
                page = acquired.page;
                if (page.block.number < cursor)
                    throw Error("backward history page does not reach requested cursor");
            }
            if (!page)
                throw Error(
                    `public history unavailable at ${cursor}; synchronize the missing range`
                );
            const start = page.fromBlock > from ? page.fromBlock : from;
            const block = page.headers.find((h) => h.number === cursor);
            if (!block) throw Error("backward history anchor missing");
            yield {
                ...page,
                fromBlock: start,
                block,
                headers: page.headers.filter((h) => h.number >= start && h.number <= cursor),
                receipts: page.receipts.filter(
                    (r) => r.block.number >= start && r.block.number <= cursor
                ),
                logs: page.logs.filter(
                    (l) =>
                        l.blockNumber != null && l.blockNumber >= start && l.blockNumber <= cursor
                ),
            };
            cursor = start - 1n;
        }
    }
    async pruneBefore(number: bigint) {
        const task = this.#coordinator.queue.then(() =>
            this.options.store.pruneBefore(this.scope, number)
        );
        this.#coordinator.queue = task.catch(() => {});
        return task;
    }
}
