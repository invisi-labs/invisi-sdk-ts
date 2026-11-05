import {
    TransactionalWalletStore,
    type AtomicRecord,
    type AtomicRecordStore,
    type WalletRecordCodec,
} from "../index";
export interface SQLiteStatement {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number | bigint };
}
/** Compatible with node:sqlite DatabaseSync and synchronous SQLite drivers. The caller owns its lifetime. */
export interface SQLiteConnection {
    exec(sql: string): void;
    prepare(sql: string): SQLiteStatement;
}
export class SQLiteAtomicRecords implements AtomicRecordStore {
    readonly #db: SQLiteConnection;
    constructor(db: SQLiteConnection) {
        this.#db = db;
        db.exec("PRAGMA busy_timeout = 5000");
        db.exec(
            "CREATE TABLE IF NOT EXISTS invisi_wallet_state (scope_key TEXT PRIMARY KEY, revision INTEGER NOT NULL, data BLOB NOT NULL)"
        );
    }
    async read(key: string): Promise<AtomicRecord | undefined> {
        const row = this.#db
            .prepare("SELECT revision, data FROM invisi_wallet_state WHERE scope_key = ?")
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
    async compareAndSwap(
        key: string,
        previousRevision: number,
        next: AtomicRecord
    ): Promise<boolean> {
        this.#db.exec("BEGIN IMMEDIATE");
        try {
            const row = this.#db
                .prepare("SELECT revision FROM invisi_wallet_state WHERE scope_key = ?")
                .get(key) as { revision: number } | undefined;
            if ((row?.revision ?? 0) !== previousRevision) {
                this.#db.exec("ROLLBACK");
                return false;
            }
            this.#db
                .prepare(
                    "INSERT INTO invisi_wallet_state(scope_key,revision,data) VALUES(?,?,?) ON CONFLICT(scope_key) DO UPDATE SET revision=excluded.revision,data=excluded.data"
                )
                .run(key, next.revision, next.data);
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
    constructor(db: SQLiteConnection, codec: WalletRecordCodec) {
        super(new SQLiteAtomicRecords(db), codec, { persistent: true });
    }
}
