import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes, hexToBytes } from "@noble/hashes/utils";
import { serializeRecord } from "./codec";
import {
    initialState,
    scopeKey,
    validateState,
    pageLimit,
    type PagedAtomicRecordStore,
    type WalletRecordCodec,
    type RecordWrite,
    type RecordRow,
} from "./store";
import type { WalletScope, WalletState } from "./state";

export const WALLET_RECORD_KINDS = [
    "notes",
    "credits",
    "operations",
    "reservations",
    "unresolvedDeliveries",
] as const;
export type WalletRecordKind = (typeof WALLET_RECORD_KINDS)[number];
export interface WalletRecordQuery {
    kind: WalletRecordKind;
    limit?: number;
    cursor?: string;
}
export interface WalletRecordItem {
    id: string;
    value: unknown;
    archived: boolean;
    canonical: "current" | "unknown";
}
export interface WalletRecordPage {
    revision: number;
    items: WalletRecordItem[];
    nextCursor?: string;
}
interface Metadata extends WalletState {
    recordLayout?: "rows-v1";
    indexSalt?: string;
    rowSequence?: bigint;
    rowLocation?: string;
    activeIntegrity?: Partial<Record<WalletRecordKind, { count: number; digest: string }>>;
    archiveCounts?: Partial<Record<WalletRecordKind, number>>;
}
interface ReadState {
    state: WalletState;
    root: Metadata;
    rows: Map<string, RecordRow>;
}
const hash = (id: string) => bytesToHex(sha256(utf8ToBytes(id)));
const identity = (kind: WalletRecordKind, id: string) => kind + ":" + id;
function entries(state: WalletState, kind: WalletRecordKind): [string, unknown][] {
    return Object.entries(state[kind] ?? {});
}
function recordOrder(value: unknown): string {
    const v = value as {
        blockNumber?: bigint;
        payload?: { plan?: { preparedAt?: { number: bigint } } };
    };
    const n = v?.blockNumber ?? v?.payload?.plan?.preparedAt?.number ?? 0n;
    if (typeof n !== "bigint" || n < 0n || n >= 1n << 256n)
        throw Error("invalid wallet record height");
    return ((1n << 256n) - 1n - n).toString(16).padStart(64, "0");
}
function keyedId(root: Metadata, kind: WalletRecordKind, id: string): string {
    if (!root.indexSalt || !/^([a-f0-9]{64})$/.test(root.indexSalt))
        throw Error("invalid encrypted wallet index secret");
    return bytesToHex(hmac(sha256, hexToBytes(root.indexSalt), utf8ToBytes(kind + ":" + id)));
}
function rowKey(
    scope: WalletScope,
    root: Metadata,
    kind: WalletRecordKind,
    id: string,
    sequence: bigint,
    archive = false
): string {
    if (sequence < 1n || sequence >= 1n << 256n) throw Error("invalid wallet row sequence");
    const order = ((1n << 256n) - 1n - sequence).toString(16).padStart(64, "0");
    return `${scopeKey(scope)}/rows/${archive ? "archive" : "active"}/${kind}/${order}/${keyedId(root, kind, id)}`;
}
function lookupKey(scope: WalletScope, root: Metadata, kind: WalletRecordKind, id: string): string {
    return `${scopeKey(scope)}/lookup/${kind}/${keyedId(root, kind, id)}`;
}
function sequenceOf(row: RecordRow): bigint {
    return (1n << 256n) - 1n - BigInt("0x" + row.key.split("/").at(-2)!);
}
function prefix(scope: WalletScope, kind: WalletRecordKind, archive = false): string {
    return `${scopeKey(scope)}/rows/${archive ? "archive" : "active"}/${kind}/`;
}
function metadata(state: WalletState): Metadata {
    const {
        notes: _notes,
        credits: _credits,
        operations: _operations,
        reservations: _reservations,
        unresolvedDeliveries: _unresolved,
        ...rest
    } = state;
    return {
        ...rest,
        unresolvedDeliveryCount: Object.keys(_unresolved ?? {}).length,
        notes: {},
        credits: {},
        reservations: {},
        operations: {},
        recordLayout: "rows-v1",
    };
}
function publicState(root: Metadata): WalletState {
    const {
        recordLayout: _layout,
        indexSalt: _salt,
        rowSequence: _sequence,
        rowLocation: _location,
        activeIntegrity: _integrity,
        archiveCounts: _counts,
        ...state
    } = root;
    return structuredClone(state);
}
function equalRecord(a: unknown, b: unknown): boolean {
    const left = serializeRecord(a),
        right = serializeRecord(b);
    return left.length === right.length && left.every((value, i) => value === right[i]);
}
function coldRecords(state: WalletState, keep: number): Set<string> {
    const result = new Set<string>();
    const held = new Set([
        ...Object.keys(state.reservations),
        ...Object.values(state.reservations),
    ]);
    for (const operation of Object.values(state.operations))
        if (!["confirmed", "failed", "expired"].includes(operation.status))
            for (const input of operation.inputs) held.add(input);
    for (const kind of ["notes", "credits", "operations"] as const) {
        const candidates = entries(state, kind)
            .filter(([id, value]) => {
                // Reverse discovery needs spent parents until chronological recovery catches up.
                if (
                    kind === "credits" &&
                    (state.creditReplayFrom !== undefined ||
                        !state.discoveryThrough ||
                        (state.observedThrough &&
                            state.discoveryThrough.number < state.observedThrough.number))
                )
                    return false;
                if (held.has(id) || held.has("credit:" + id.split(":")[0])) return false;
                const record = value as {
                    spent?: string;
                    status?: string;
                    payload?: { externalized?: boolean };
                };
                return kind === "operations"
                    ? record.status === "confirmed" ||
                          (["failed", "expired"].includes(record.status ?? "") &&
                              !record.payload?.externalized)
                    : record.spent === "spent";
            })
            .sort(
                (a, b) =>
                    recordOrder(a[1]).localeCompare(recordOrder(b[1])) || a[0].localeCompare(b[0])
            );
        for (const [id] of candidates.slice(keep)) result.add(identity(kind, id));
    }
    return result;
}
function integrity(rows: readonly RecordRow[]): { count: number; digest: string } {
    const digest = sha256.create();
    for (const row of [...rows].sort((a, b) => a.key.localeCompare(b.key))) {
        digest.update(utf8ToBytes(row.key + "\0" + row.revision + "\0"));
        digest.update(sha256(row.data));
    }
    return { count: rows.length, digest: bytesToHex(digest.digest()) };
}
/** Metadata and encrypted rows commit under one revision guard; historical rows stay out of active snapshots. */
export class RecordWalletPersistence {
    constructor(
        readonly records: PagedAtomicRecordStore,
        readonly codec: WalletRecordCodec,
        readonly recentRecords: number
    ) {
        if (!Number.isInteger(recentRecords) || recentRecords < 0 || recentRecords > 10_000)
            throw Error("invalid recent wallet record limit");
    }
    private async root(scope: WalletScope): Promise<Metadata> {
        const key = scopeKey(scope),
            record = await this.records.read(key);
        if (!record) return initialState(scope);
        const state = await this.codec.decode(record.data, { key, revision: record.revision });
        validateState(state, scope, record.revision);
        return state;
    }
    private async decode(
        scope: WalletScope,
        kind: WalletRecordKind,
        row: RecordRow,
        root: Metadata
    ): Promise<[string, unknown, WalletState]> {
        const state = await this.codec.decode(row.data, { key: row.key, revision: row.revision });
        const reservations = state.reservations;
        state.reservations = {};
        validateState(state, scope, row.revision);
        state.reservations = reservations;
        const values = entries(state, kind);
        if (values.length !== 1) throw Error("invalid wallet row encoding");
        const [id, value] = values[0]!;
        const sequence = (state as Metadata).rowSequence;
        if (
            typeof sequence !== "bigint" ||
            (row.key !== rowKey(scope, root, kind, id, sequence) &&
                row.key !== rowKey(scope, root, kind, id, sequence, true))
        )
            throw Error("wallet row binding mismatch");
        return [id, value, state];
    }
    async read(scope: WalletScope): Promise<ReadState> {
        for (let attempt = 0; attempt < 32; attempt++) {
            const root = await this.root(scope);
            if (root.recordLayout !== "rows-v1") return { state: root, root, rows: new Map() };
            const state = publicState(root),
                rows = new Map<string, RecordRow>();
            for (const kind of WALLET_RECORD_KINDS) {
                let after: string | undefined;
                while (true) {
                    const page = await this.records.readPage(prefix(scope, kind), after, 128);
                    for (const row of page) {
                        const [id, value] = await this.decode(scope, kind, row, root);
                        (state[kind] ??= {})[id] = value as never;
                        rows.set(identity(kind, id), row);
                    }
                    if (page.length < 128) break;
                    after = page.at(-1)!.key;
                }
            }
            if ((await this.records.read(scopeKey(scope)))?.revision === root.revision) {
                for (const kind of WALLET_RECORD_KINDS) {
                    const expected = root.activeIntegrity?.[kind],
                        activePrefix = prefix(scope, kind),
                        actual = integrity(
                            [...rows.values()].filter((row) => row.key.startsWith(activePrefix))
                        );
                    if (
                        !expected ||
                        expected.count !== actual.count ||
                        expected.digest !== actual.digest
                    )
                        throw Error("wallet active row integrity mismatch");
                }
                validateState(state, scope, root.revision);
                return { state, root, rows };
            }
        }
        throw Error("wallet changed during snapshot read; retry");
    }
    async summary(scope: WalletScope): Promise<WalletState> {
        for (let attempt = 0; attempt < 32; attempt++) {
            const root = await this.root(scope);
            if (root.recordLayout !== "rows-v1") return publicState(root);
            if (!this.records.count) {
                return publicState((await this.read(scope)).root);
            }
            const counts = await Promise.all(
                WALLET_RECORD_KINDS.map((kind) => this.records.count!(prefix(scope, kind)))
            );
            if ((await this.records.read(scopeKey(scope)))?.revision !== root.revision) continue;
            WALLET_RECORD_KINDS.forEach((kind, index) => {
                if (root.activeIntegrity?.[kind]?.count !== counts[index])
                    throw Error("wallet active row integrity mismatch");
            });
            return publicState(root);
        }
        throw Error("wallet changed during summary read; retry");
    }
    private async encodeChecked(state: Metadata, key: string): Promise<Uint8Array> {
        const context = { key, revision: state.revision };
        const bytes = await this.codec.encode(state, context);
        const decoded = (await this.codec.decode(bytes, context)) as Metadata;
        const fields = [
            "recordLayout",
            "indexSalt",
            "rowSequence",
            "rowLocation",
            "recoveryBoundary",
            "creditReplayFrom",
            "creditReplayRevision",
        ] as const;
        const points = [
            "observedThrough",
            "discoveryThrough",
            "creditReplayThrough",
            "creditReplayTarget",
        ] as const;
        const sameRanges =
            state.discoveryRanges === undefined
                ? decoded.discoveryRanges === undefined
                : Array.isArray(decoded.discoveryRanges) &&
                  decoded.discoveryRanges.length === state.discoveryRanges.length &&
                  state.discoveryRanges.every((range, i) => {
                      const other = decoded.discoveryRanges![i]!;
                      return (
                          range.fromBlock === other.fromBlock &&
                          range.block.number === other.block.number &&
                          range.block.hash === other.block.hash
                      );
                  });
        const valid =
            bytesToHex(serializeRecord(state.preparationSnapshot)) ===
                bytesToHex(serializeRecord(decoded.preparationSnapshot)) &&
            fields.every((field) => decoded[field] === state[field]) &&
            sameRanges &&
            points.every(
                (field) =>
                    decoded[field]?.number === state[field]?.number &&
                    decoded[field]?.hash === state[field]?.hash
            ) &&
            WALLET_RECORD_KINDS.every(
                (kind) =>
                    decoded.activeIntegrity?.[kind]?.count ===
                        state.activeIntegrity?.[kind]?.count &&
                    decoded.activeIntegrity?.[kind]?.digest ===
                        state.activeIntegrity?.[kind]?.digest &&
                    decoded.archiveCounts?.[kind] === state.archiveCounts?.[kind]
            );
        if (!valid) throw Error("wallet codec must preserve storage metadata losslessly");
        return bytes;
    }
    private async encodeRow(
        scope: WalletScope,
        state: Metadata,
        kind: WalletRecordKind,
        id: string,
        value: unknown,
        archive: boolean,
        sequence: bigint
    ): Promise<RecordWrite> {
        const key = rowKey(scope, state, kind, id, sequence, archive),
            row = initialState(scope) as Metadata;
        row.rowSequence = sequence;
        row.revision = state.revision;
        if (state.publicHistoryGeneration !== undefined)
            row.publicHistoryGeneration = state.publicHistoryGeneration;
        (row[kind] ??= {})[id] = value as never;
        return {
            key,
            record: {
                revision: state.revision,
                data: await this.encodeChecked(row, key),
            },
        };
    }
    private async locate(
        scope: WalletScope,
        root: Metadata,
        kind: WalletRecordKind,
        id: string
    ): Promise<{ sequence: bigint; key: string } | undefined> {
        const key = lookupKey(scope, root, kind, id),
            record = await this.records.read(key);
        if (!record) return undefined;
        const value = (await this.codec.decode(record.data, {
            key,
            revision: record.revision,
        })) as Metadata;
        validateState(value, scope, record.revision);
        const sequence = value.rowSequence;
        if (
            typeof sequence !== "bigint" ||
            !value.rowLocation ||
            ![
                rowKey(scope, root, kind, id, sequence),
                rowKey(scope, root, kind, id, sequence, true),
            ].includes(value.rowLocation)
        )
            throw Error("invalid encrypted wallet row locator");
        return { sequence, key: value.rowLocation };
    }
    async transaction<T>(scope: WalletScope, action: (draft: WalletState) => T): Promise<T> {
        for (let attempt = 0; attempt < 100; attempt++) {
            const loaded = await this.read(scope),
                base = loaded.state,
                previous = base.revision;
            const draft = structuredClone(base) as Metadata,
                result = action(draft);
            if (result && typeof result === "object" && "then" in result) {
                Promise.resolve(result).catch(() => {});
                throw Error("wallet transaction action must be synchronous");
            }
            validateState(draft, scope, previous);
            if (!Number.isSafeInteger(previous + 1)) throw Error("wallet revision exhausted");
            draft.revision = previous + 1;
            draft.indexSalt =
                loaded.root.indexSalt ?? bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
            let counter = loaded.root.rowSequence ?? 0n;
            const cold = coldRecords(draft, this.recentRecords),
                writes = new Map<string, RecordWrite>();
            for (const kind of WALLET_RECORD_KINDS) {
                const before = new Map(entries(base, kind)),
                    after = new Map(entries(draft, kind));
                for (const [id] of before)
                    if (!after.has(id)) {
                        const old = loaded.rows.get(identity(kind, id));
                        if (old) writes.set(old.key, { key: old.key });
                        const locator = lookupKey(scope, draft, kind, id);
                        writes.set(locator, { key: locator });
                    }
                for (const [id, value] of after) {
                    const archive = cold.has(identity(kind, id)),
                        old = loaded.rows.get(identity(kind, id));
                    if (old && !archive && equalRecord(before.get(id), value)) continue;
                    const located = old
                        ? { sequence: sequenceOf(old), key: old.key }
                        : loaded.root.recordLayout === "rows-v1"
                          ? await this.locate(scope, draft, kind, id)
                          : undefined;
                    const sequence = located?.sequence ?? ++counter;
                    const write = await this.encodeRow(
                        scope,
                        draft,
                        kind,
                        id,
                        value,
                        archive,
                        sequence
                    );
                    writes.set(write.key, write);
                    if (located && located.key !== write.key)
                        writes.set(located.key, { key: located.key });
                    const key = lookupKey(scope, draft, kind, id),
                        locator = initialState(scope) as Metadata;
                    locator.revision = draft.revision;
                    locator.rowSequence = sequence;
                    locator.rowLocation = write.key;
                    writes.set(key, {
                        key,
                        record: {
                            revision: draft.revision,
                            data: await this.codec.encode(locator, {
                                key,
                                revision: draft.revision,
                            }),
                        },
                    });
                }
            }
            draft.rowSequence = counter;
            const active = structuredClone(draft);
            for (const kind of WALLET_RECORD_KINDS)
                for (const [id] of entries(active, kind))
                    if (cold.has(identity(kind, id))) delete active[kind]![id];
            validateState(active, scope, draft.revision);
            const activeRows = new Map([...loaded.rows.values()].map((row) => [row.key, row]));
            const archiveCounts = { ...loaded.root.archiveCounts };
            const prefixes = WALLET_RECORD_KINDS.map((kind) => ({
                kind,
                active: prefix(scope, kind),
                archive: prefix(scope, kind, true),
            }));
            for (const write of writes.values()) {
                for (const { kind, active, archive } of prefixes) {
                    if (write.key.startsWith(active)) {
                        if (write.record)
                            activeRows.set(write.key, { key: write.key, ...write.record });
                        else activeRows.delete(write.key);
                    }
                    if (write.key.startsWith(archive)) {
                        const exists = !!(await this.records.read(write.key));
                        archiveCounts[kind] =
                            (archiveCounts[kind] ?? 0) +
                            (write.record ? (exists ? 0 : 1) : exists ? -1 : 0);
                    }
                }
            }
            const root = metadata(draft),
                key = scopeKey(scope);
            root.archiveCounts = archiveCounts;
            root.activeIntegrity = {};
            for (const { kind, active } of prefixes)
                root.activeIntegrity[kind] = integrity(
                    [...activeRows.values()].filter((row) => row.key.startsWith(active))
                );
            const data = await this.encodeChecked(root, key);
            if (
                await this.records.compareAndSwapBatch(
                    key,
                    previous,
                    { revision: draft.revision, data },
                    [...writes.values()]
                )
            )
                return result;
        }
        throw Error("wallet transaction contention limit exceeded");
    }
    async restoreReorgedOperations(scope: WalletScope, fromBlock: bigint): Promise<void> {
        const root = await this.root(scope);
        if (root.recordLayout !== "rows-v1") return;
        if (!root.invalidated)
            throw Error("archived journals can only be restored while inventory is invalidated");
        let after: string | undefined;
        while (true) {
            const rows = await this.records.readPage(prefix(scope, "operations", true), after, 64);
            const operations: import("./state").OperationRecord[] = [];
            for (const row of rows) {
                const [, value] = await this.decode(scope, "operations", row, root);
                const operation = value as import("./state").OperationRecord;
                const externalized = (operation.payload as { externalized?: boolean } | undefined)
                    ?.externalized;
                if (
                    externalized &&
                    (!operation.confirmedAt || operation.confirmedAt.number >= fromBlock)
                )
                    operations.push(operation);
            }
            if (operations.length)
                await this.transaction(scope, (draft) => {
                    if (!draft.invalidated)
                        throw Error("wallet rebuild raced archived journal restoration");
                    for (const operation of operations) {
                        if (draft.operations[operation.id]) continue;
                        draft.operations[operation.id] = { ...operation, status: "reorged" };
                        for (const id of operation.inputs)
                            if (!draft.reservations[id]) draft.reservations[id] = operation.id;
                    }
                });
            if (rows.length < 64) break;
            after = rows.at(-1)!.key;
        }
    }
    async readRecords(scope: WalletScope, query: WalletRecordQuery): Promise<WalletRecordPage> {
        if (!WALLET_RECORD_KINDS.includes(query.kind)) throw Error("invalid wallet record kind");
        const limit = query.limit ?? 50;
        pageLimit(limit);
        const root = await this.root(scope),
            key = scopeKey(scope);
        let after: string | undefined;
        if (query.cursor) {
            let cursor: { scope: string; kind: string; revision: number; after: string };
            try {
                cursor = JSON.parse(query.cursor);
            } catch {
                throw Error("invalid wallet history cursor");
            }
            if (
                cursor.scope !== key ||
                cursor.kind !== query.kind ||
                typeof cursor.after !== "string"
            )
                throw Error("wallet history cursor scope mismatch");
            if (cursor.revision !== root.revision)
                throw Error("wallet history changed; restart pagination");
            after = cursor.after;
        }
        if (root.recordLayout !== "rows-v1") {
            const values = entries(root, query.kind).map(([id, value]) => ({
                id,
                value,
                archived: false,
                canonical: "current" as const,
            }));
            values.sort(
                (a, b) =>
                    recordOrder(a.value).localeCompare(recordOrder(b.value)) ||
                    hash(a.id).localeCompare(hash(b.id))
            );
            const filtered = values.filter(
                (v) => !after || recordOrder(v.value) + "/" + hash(v.id) > after
            );
            const items = filtered.slice(0, limit),
                last = items.at(-1);
            return {
                revision: root.revision,
                items,
                ...(filtered.length > limit && last
                    ? {
                          nextCursor: JSON.stringify({
                              scope: key,
                              kind: query.kind,
                              revision: root.revision,
                              after: recordOrder(last.value) + "/" + hash(last.id),
                          }),
                      }
                    : {}),
            };
        }
        if (this.records.count) {
            const [archived, active] = await Promise.all([
                this.records.count(prefix(scope, query.kind, true)),
                this.records.count(prefix(scope, query.kind)),
            ]);
            if ((await this.records.read(key))?.revision !== root.revision)
                throw Error("wallet history changed; restart pagination");
            if (active !== root.activeIntegrity?.[query.kind]?.count)
                throw Error("wallet active row integrity mismatch");
            if (archived !== (root.archiveCounts?.[query.kind] ?? 0))
                throw Error("wallet archive row integrity mismatch");
        }
        const active = prefix(scope, query.kind),
            archive = prefix(scope, query.kind, true);
        const [a, b] = await Promise.all([
            this.records.readPage(
                active,
                after ? active + after : undefined,
                limit + 1 > 256 ? 256 : limit + 1
            ),
            this.records.readPage(
                archive,
                after ? archive + after : undefined,
                limit + 1 > 256 ? 256 : limit + 1
            ),
        ]);
        const candidates = [
            ...a.map((row) => ({ row, archived: false, suffix: row.key.slice(active.length) })),
            ...b.map((row) => ({ row, archived: true, suffix: row.key.slice(archive.length) })),
        ].sort((x, y) => x.suffix.localeCompare(y.suffix));
        const selected = candidates.slice(0, limit),
            items: WalletRecordItem[] = [];
        for (const item of selected) {
            const [id, value, state] = await this.decode(scope, query.kind, item.row, root);
            items.push({
                id,
                value,
                archived: item.archived,
                canonical:
                    !root.invalidated &&
                    state.publicHistoryGeneration === root.publicHistoryGeneration
                        ? "current"
                        : "unknown",
            });
        }
        if ((await this.records.read(key))?.revision !== root.revision)
            throw Error("wallet history changed; restart pagination");
        const hasMore = candidates.length > limit || a.length === 256 || b.length === 256;
        return {
            revision: root.revision,
            items,
            ...(hasMore && selected.length
                ? {
                      nextCursor: JSON.stringify({
                          scope: key,
                          kind: query.kind,
                          revision: root.revision,
                          after: selected.at(-1)!.suffix,
                      }),
                  }
                : {}),
        };
    }
}
