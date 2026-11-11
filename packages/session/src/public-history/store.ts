import { mergeCoverage, type CoverageRange } from "./coverage";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { CanonicalBlock, CanonicalReceipt } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { DeliveryEventLog } from "@invisi-labs/sdk/session-support";
import { isPagedRecords, type AtomicRecordStore } from "../storage/store";
import { deserializeRecord, serializeRecord } from "../storage/codec";

export interface PublicHistoryScope {
    chainId: bigint;
    protocolAddress: Hex;
    runtimeCodeHash: Hex;
    deploymentBlock: bigint;
}
export interface PublicHistoryPage {
    fromBlock: bigint;
    block: CanonicalBlock;
    headers: CanonicalBlock[];
    receipts: CanonicalReceipt[];
    logs: DeliveryEventLog[];
    verifiedPositions: string[];
}
export interface PublicPageReference {
    fromBlock: bigint;
    block: CanonicalBlock;
    parentHash: Hex;
    key: string;
    digest: string;
    bytes: number;
}
export interface PublicHistorySnapshot {
    schemaVersion: 1;
    scopeKey: string;
    generation: number;
    revision: number;
    reorgFrom?: bigint;
    coverage?: CoverageRange[];
    indexedHead?: CanonicalBlock;
    knownHead?: CanonicalBlock;
    /** Validated contiguous history; retained pages below this point may have been evicted. */
    through?: CanonicalBlock;
    pages: PublicPageReference[];
}
export function publicScopeKey(scope: PublicHistoryScope): string {
    if (
        typeof scope.chainId !== "bigint" ||
        scope.chainId <= 0n ||
        scope.chainId >= 1n << 64n ||
        typeof scope.deploymentBlock !== "bigint" ||
        scope.deploymentBlock < 0n ||
        !/^0x[0-9a-fA-F]{40}$/.test(scope.protocolAddress) ||
        BigInt(scope.protocolAddress) === 0n ||
        !/^0x[0-9a-fA-F]{64}$/.test(scope.runtimeCodeHash)
    )
        throw Error("invalid public history deployment");
    return (
        "public-history/v1/" +
        bytesToHex(
            sha256(
                utf8ToBytes(
                    JSON.stringify([
                        scope.chainId.toString(),
                        scope.protocolAddress.toLowerCase(),
                        scope.runtimeCodeHash.toLowerCase(),
                        scope.deploymentBlock.toString(),
                    ])
                )
            )
        )
    );
}
const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
export const historyPosition = (treeId: bigint, leafIndex: number, commitment: Hex) =>
    `${treeId}:${leafIndex}:${commitment.toLowerCase()}`;

export interface PublicHistoryRetention {
    maxBytes: number;
    maxPages: number;
    maxPageBytes: number;
}
export const DEFAULT_PUBLIC_HISTORY_RETENTION: Readonly<PublicHistoryRetention> = Object.freeze({
    maxBytes: 128 * 1024 * 1024,
    maxPages: 4096,
    maxPageBytes: 8 * 1024 * 1024,
});
export class PublicHistoryCapacityError extends Error {}
export class PublicHistoryPageError extends Error {}

/** Public records are separate from wallet ciphertext; adapters must protect their integrity. */
export class PublicHistoryStore {
    readonly persistent: boolean;
    readonly retention: Readonly<PublicHistoryRetention>;
    constructor(
        readonly records: AtomicRecordStore,
        options: { persistent: boolean; retention?: Partial<PublicHistoryRetention> }
    ) {
        this.persistent = options.persistent;
        const limits = { ...DEFAULT_PUBLIC_HISTORY_RETENTION, ...options.retention };
        if (options.retention?.maxPageBytes === undefined)
            limits.maxPageBytes = Math.min(limits.maxBytes, limits.maxPageBytes);
        this.retention = Object.freeze(limits);
        for (const value of Object.values(this.retention))
            if (!Number.isSafeInteger(value) || value < 1)
                throw Error("invalid public cache retention");
        if (this.retention.maxPages > 4096 || this.retention.maxPageBytes > this.retention.maxBytes)
            throw Error("invalid public cache retention bounds");
    }
    async snapshot(scope: PublicHistoryScope): Promise<PublicHistorySnapshot> {
        const key = publicScopeKey(scope),
            record = await this.records.read(key);
        if (!record)
            return {
                schemaVersion: 1,
                scopeKey: key,
                generation: 1,
                revision: 0,
                pages: [],
                coverage: [],
            };
        const state = deserializeRecord(record.data) as PublicHistorySnapshot;
        if (
            state.schemaVersion !== 1 ||
            state.scopeKey !== key ||
            state.revision !== record.revision ||
            !Number.isSafeInteger(state.generation) ||
            state.generation < 1 ||
            !Array.isArray(state.pages)
        )
            throw Error("invalid public history metadata");
        let end = scope.deploymentBlock - 1n;
        for (const page of state.pages) {
            if (
                page.fromBlock <= end ||
                page.block.number < page.fromBlock ||
                !page.key.startsWith(key + "/page/")
            )
                throw Error("invalid public history coverage");
            end = page.block.number;
        }
        if (!state.coverage) {
            let ranges: CoverageRange[] = state.through
                ? [{ fromBlock: scope.deploymentBlock, block: state.through }]
                : [];
            for (const page of state.pages)
                ranges = mergeCoverage(ranges, { fromBlock: page.fromBlock, block: page.block });
            state.coverage = ranges;
        }
        return structuredClone(state);
    }
    async read(reference: PublicPageReference): Promise<PublicHistoryPage> {
        const record = await this.records.read(reference.key);
        if (!record || digest(record.data) !== reference.digest)
            throw new PublicHistoryPageError(
                "public history page missing or corrupt; synchronize again"
            );
        let page: PublicHistoryPage;
        try {
            page = deserializeRecord(record.data) as PublicHistoryPage;
        } catch {
            throw new PublicHistoryPageError("invalid public history page encoding");
        }
        if (
            page.fromBlock !== reference.fromBlock ||
            page.block.hash !== reference.block.hash ||
            page.block.number !== reference.block.number
        )
            throw new PublicHistoryPageError("public history page binding mismatch");
        return page;
    }
    async pageAt(
        scope: PublicHistoryScope,
        number: bigint
    ): Promise<PublicHistoryPage | undefined> {
        const snapshot = await this.snapshot(scope);
        const page = snapshot.pages.find((p) => p.fromBlock <= number && p.block.number >= number);
        return page ? this.read(page) : undefined;
    }
    private async update(
        scope: PublicHistoryScope,
        action: (snapshot: PublicHistorySnapshot) => void
    ) {
        for (let attempt = 0; attempt < 32; attempt++) {
            const state = await this.snapshot(scope),
                previous = state.revision;
            action(state);
            state.revision++;
            if (
                await this.records.compareAndSwap(state.scopeKey, previous, {
                    revision: state.revision,
                    data: serializeRecord(state),
                })
            )
                return state;
        }
        throw Error("public history contention");
    }
    async noteHead(
        scope: PublicHistoryScope,
        indexedHead: CanonicalBlock,
        knownHead: CanonicalBlock
    ) {
        const before = await this.snapshot(scope);
        if (
            before.indexedHead?.hash === indexedHead.hash &&
            before.knownHead?.hash === knownHead.hash
        )
            return before;
        return this.update(scope, (state) => {
            state.indexedHead = { ...indexedHead };
            state.knownHead = { ...knownHead };
        });
    }
    async append(scope: PublicHistoryScope, input: PublicHistoryPage, generation: number) {
        const page = structuredClone(input);
        if (
            page.fromBlock < scope.deploymentBlock ||
            page.headers.length !== Number(page.block.number - page.fromBlock + 1n) ||
            !page.headers.length ||
            page.headers.length > 256
        )
            throw Error("invalid public history page range");
        for (let i = 0; i < page.headers.length; i++) {
            const h = page.headers[i]!;
            if (
                h.number !== page.fromBlock + BigInt(i) ||
                (i > 0 && h.parentHash !== page.headers[i - 1]!.hash)
            )
                throw Error("noncontiguous public headers");
        }
        if (page.headers.at(-1)!.hash !== page.block.hash)
            throw Error("public history anchor mismatch");
        // Explicit projection prevents accidentally storing account snapshots alongside public data.
        const bytes = serializeRecord({
            fromBlock: page.fromBlock,
            block: page.block,
            headers: page.headers,
            receipts: page.receipts,
            logs: page.logs,
            verifiedPositions: page.verifiedPositions,
        });
        if (bytes.length > this.retention.maxPageBytes)
            throw new PublicHistoryCapacityError(
                "public page exceeds cache budget; reduce pageSize"
            );
        const key =
            publicScopeKey(scope) +
            `/page/${generation}/${page.fromBlock}/${page.block.number}/${page.block.hash}`;
        const existing = await this.records.read(key);
        if (!existing || digest(existing.data) !== digest(bytes)) {
            if (existing && existing.data.length) throw Error("conflicting public history page");
            if (
                !(await this.records.compareAndSwap(key, existing?.revision ?? 0, {
                    revision: (existing?.revision ?? 0) + 1,
                    data: bytes,
                }))
            )
                throw Error("public history page contention");
        }
        const removed: PublicPageReference[] = [];
        const result = await this.update(scope, (state) => {
            removed.length = 0;
            if (state.generation !== generation) throw Error("public history generation changed");
            const overlaps = state.pages.filter(
                (p) => p.fromBlock <= page.block.number && p.block.number >= page.fromBlock
            );
            if (overlaps.length) {
                if (
                    overlaps.length === 1 &&
                    overlaps[0]!.key === key &&
                    overlaps[0]!.digest === digest(bytes)
                )
                    return;
                throw Error("public history coverage conflict; retry synchronization");
            }
            state.pages.push({
                fromBlock: page.fromBlock,
                block: page.block,
                parentHash: page.headers[0]!.parentHash,
                key,
                digest: digest(bytes),
                bytes: bytes.length,
            });
            state.pages.sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
            for (let i = 1; i < state.pages.length; i++) {
                const left = state.pages[i - 1]!,
                    right = state.pages[i]!;
                if (
                    left.block.number + 1n === right.fromBlock &&
                    left.block.hash !== right.parentHash
                )
                    throw Error("public history parent conflict");
            }
            state.coverage = mergeCoverage(state.coverage ?? [], {
                fromBlock: page.fromBlock,
                block: page.block,
            });
            const prefix = state.coverage.find(
                (range) => range.fromBlock === scope.deploymentBlock
            );
            if (prefix) state.through = prefix.block;
            else delete state.through;
            let total = state.pages.reduce((sum, p) => sum + p.bytes, 0);
            // Coverage is sorted by block range; backfilling old data must not displace the head.
            const oldest = [...state.pages];
            while (
                state.pages.length > this.retention.maxPages ||
                total > this.retention.maxBytes
            ) {
                const victim = oldest.shift()!;
                state.pages = state.pages.filter((p) => p.key !== victim.key);
                total -= victim.bytes;
                removed.push(victim);
            }
        });
        await this.removePages(scope, removed);
        return result;
    }
    private async removePages(scope: PublicHistoryScope, pages: readonly PublicPageReference[]) {
        if (isPagedRecords(this.records)) {
            // Recheck the metadata revision so another process cannot have re-published a page.
            for (let attempt = 0; attempt < 32; attempt++) {
                const snapshot = await this.snapshot(scope);
                const removable = pages.filter(
                    (p) => !snapshot.pages.some((active) => active.key === p.key)
                );
                if (!removable.length) return;
                const record = await this.records.read(snapshot.scopeKey);
                if (!record || record.revision !== snapshot.revision) continue;
                if (
                    await this.records.compareAndSwapBatch(
                        snapshot.scopeKey,
                        record.revision,
                        { revision: record.revision, data: record.data },
                        removable.map((p) => ({ key: p.key }))
                    )
                )
                    return;
            }
            throw Error("public cache cleanup contention; retry maintenance");
        }
        for (const page of pages) {
            const record = await this.records.read(page.key);
            if (record)
                await this.records.compareAndSwap(page.key, record.revision, {
                    revision: record.revision + 1,
                    data: new Uint8Array(),
                });
        }
    }
    async rewind(scope: PublicHistoryScope, ancestor: bigint, ancestorBlock?: CanonicalBlock) {
        if (!ancestorBlock && ancestor >= scope.deploymentBlock)
            ancestorBlock = (await this.pageAt(scope, ancestor))?.headers.find(
                (block) => block.number === ancestor
            );
        if (ancestorBlock && ancestorBlock.number !== ancestor)
            throw Error("invalid rewind anchor");
        const anchor = ancestorBlock;
        const removed: PublicPageReference[] = [];
        const result = await this.update(scope, (state) => {
            removed.length = 0;
            removed.push(...state.pages.filter((p) => p.block.number > ancestor));
            state.generation++;
            const from = ancestor + 1n;
            state.reorgFrom =
                state.reorgFrom === undefined || from < state.reorgFrom ? from : state.reorgFrom;
            state.pages = state.pages.filter((p) => p.block.number <= ancestor);
            const ranges = (state.coverage ?? []).filter((range) => range.block.number <= ancestor);
            const overlap = (state.coverage ?? []).find(
                (range) => range.fromBlock <= ancestor && range.block.number > ancestor
            );
            state.coverage =
                overlap && anchor
                    ? mergeCoverage(ranges, { fromBlock: overlap.fromBlock, block: anchor })
                    : ranges;
            const prefix = state.coverage.find(
                (range) => range.fromBlock === scope.deploymentBlock
            );
            if (prefix) state.through = prefix.block;
            else delete state.through;
        });
        await this.removePages(scope, removed);
        return result;
    }
    async discard(scope: PublicHistoryScope, reference: PublicPageReference) {
        await this.update(scope, (state) => {
            state.pages = state.pages.filter((p) => p.key !== reference.key);
        });
        await this.removePages(scope, [reference]);
    }
    /** Evicts whole pages. The historical checkpoint is not a promise of retained offline coverage. */
    async pruneBefore(scope: PublicHistoryScope, number: bigint) {
        const removed: PublicPageReference[] = [];
        const state = await this.update(scope, (state) => {
            removed.length = 0;
            removed.push(...state.pages.filter((p) => p.block.number < number));
            state.pages = state.pages.filter((p) => p.block.number >= number);
        });
        await this.removePages(scope, removed);
        return state;
    }
}
