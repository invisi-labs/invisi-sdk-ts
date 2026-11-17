import { PublicHistoryStore, type PublicHistoryRetention } from "../public-history/store";
import {
    TransactionalWalletStore,
    type AtomicRecord,
    type PagedAtomicRecordStore,
    type RecordRow,
    type RecordWrite,
    pageLimit,
    type WalletRecordCodec,
} from "../index";
export interface SQLiteStatement {
    get(...params: unknown[]): unknown;
    all?(...params: unknown[]): unknown[];
    run(...params: unknown[]): { changes: number | bigint };
}
/** Compatible with node:sqlite DatabaseSync and synchronous SQLite drivers. The caller owns its lifetime. */
export interface SQLiteConnection {
    exec(sql: string): void;
    prepare(sql: string): SQLiteStatement;
}
export class SQLiteAtomicRecords implements PagedAtomicRecordStore {
    readonly #db: SQLiteConnection;
    readonly #table: string;
    constructor(
        db: SQLiteConnection,
        table: "invisi_wallet_state" | "invisi_public_history" = "invisi_wallet_state"
    ) {
        if (!["invisi_wallet_state", "invisi_public_history"].includes(table))
            throw Error("invalid SQLite table");
        this.#table = table;
        this.#db = db;
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec(
            `CREATE TABLE IF NOT EXISTS ${this.#table} (scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data BLOB NOT NULL)`
        );
    }
    async read(key: string): Promise<AtomicRecord | undefined> {
        const row = this.#db
            .prepare(`SELECT revision, data FROM ${this.#table} WHERE scope_key = ?`)
            .get(key) as { revision: number; data: Uint8Array } | undefined;
        if (!row) return undefined;
        if (
            !Number.isSafeInteger(row.revision) ||
            row.revision < 1 ||
            !(row.data instanceof Uint8Array)
        )
            throw new Error("invalid SQLite wallet record");
        return { revision: row.revision, data: Uint8Array.from(row.data) };
    }
    async count(prefix: string): Promise<number> {
        const row = this.#db
            .prepare(
                `SELECT count(*) AS n FROM ${this.#table} WHERE scope_key >= ? AND scope_key < ?`
            )
            .get(prefix, prefix + "\uffff") as { n: number };
        return row.n;
    }
    async readPage(prefix: string, after: string | undefined, limit: number): Promise<RecordRow[]> {
        pageLimit(limit);
        const statement = this.#db.prepare(
            `SELECT scope_key,revision,data FROM ${this.#table} WHERE scope_key >= ? AND scope_key < ? AND scope_key > ? ORDER BY scope_key LIMIT ?`
        );
        if (statement.all) {
            return (
                statement.all(prefix, prefix + "\uffff", after ?? "", limit) as {
                    scope_key: string;
                    revision: number;
                    data: Uint8Array;
                }[]
            ).map((row) => ({
                key: row.scope_key,
                revision: row.revision,
                data: Uint8Array.from(row.data),
            }));
        }
        const rows: RecordRow[] = [];
        let cursor = after ?? "";
        for (let i = 0; i < limit; i++) {
            const row = this.#db
                .prepare(
                    `SELECT scope_key,revision,data FROM ${this.#table} WHERE scope_key >= ? AND scope_key < ? AND scope_key > ? ORDER BY scope_key LIMIT 1`
                )
                .get(prefix, prefix + "\uffff", cursor) as
                { scope_key: string; revision: number; data: Uint8Array } | undefined;
            if (!row) break;
            rows.push({
                key: row.scope_key,
                revision: row.revision,
                data: Uint8Array.from(row.data),
            });
            cursor = row.scope_key;
        }
        return rows;
    }
    compareAndSwap(key: string, previousRevision: number, next: AtomicRecord): Promise<boolean> {
        return this.compareAndSwapBatch(key, previousRevision, next, []);
    }
    async compareAndSwapBatch(
        key: string,
        previousRevision: number,
        next: AtomicRecord,
        writes: readonly RecordWrite[]
    ): Promise<boolean> {
        if (writes.some((write) => write.key === key))
            throw Error("batch cannot replace its guard");
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const row = this.#db
                .prepare(`SELECT revision FROM ${this.#table} WHERE scope_key = ?`)
                .get(key) as { revision: number } | undefined;
            if ((row?.revision ?? 0) !== previousRevision) {
                this.#db.exec("ROLLBACK");
                return false;
            }
            const put = this.#db.prepare(
                `INSERT INTO ${this.#table}(scope_key,revision,data) VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,data=excluded.data`
            );
            const remove = this.#db.prepare(`DELETE FROM ${this.#table} WHERE scope_key = ?`);
            for (const write of writes) {
                if (write.record) put.run(write.key, write.record.revision, write.record.data);
                else remove.run(write.key);
            }
            put.run(key, next.revision, next.data);
            this.#db.exec("COMMIT");
            return true;
        } catch (error) {
            try {
                this.#db.exec("ROLLBACK");
            } catch {}
            throw error;
        }
    }
}
/** Explicit persistent storage; encryption/serialization is always chosen by the caller. */
export class SQLiteWalletStore extends TransactionalWalletStore {
    constructor(
        db: SQLiteConnection,
        codec: WalletRecordCodec,
        options: { recentRecords?: number } = {}
    ) {
        super(new SQLiteAtomicRecords(db), codec, { persistent: true, ...options });
    }
}

export class SQLitePublicHistoryStore extends PublicHistoryStore {
    constructor(
        db: SQLiteConnection,
        options: { retention?: Partial<PublicHistoryRetention> } = {}
    ) {
        super(new SQLiteAtomicRecords(db, "invisi_public_history"), {
            persistent: true,
            ...options,
        });
    }
}
