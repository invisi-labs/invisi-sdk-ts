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
/** Native IndexedDB CAS transactions. Encryption happens outside active IDB transactions. */
export class IndexedDBAtomicRecords implements PagedAtomicRecordStore {
    readonly #database: Promise<IDBDatabase>;
    constructor(name: string, factory: IDBFactory = indexedDB) {
        if (!name) throw new Error("IndexedDB database name is required");
        this.#database = new Promise((resolve, reject) => {
            const request = factory.open(name, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore("walletRecords");
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error("could not open wallet IndexedDB"));
            request.onblocked = () => reject(new Error("wallet IndexedDB upgrade is blocked"));
        });
    }
    async read(key: string): Promise<AtomicRecord | undefined> {
        const db = await this.#database;
        return new Promise((resolve, reject) => {
            const tx = db.transaction("walletRecords", "readonly"),
                request = tx.objectStore("walletRecords").get(key);
            let result: AtomicRecord | undefined;
            request.onsuccess = () => {
                const value = request.result as AtomicRecord | undefined;
                if (value) result = { revision: value.revision, data: Uint8Array.from(value.data) };
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(new Error("wallet IndexedDB read failed"));
            tx.onabort = () => reject(new Error("wallet IndexedDB read aborted"));
        });
    }
    async count(prefix: string): Promise<number> {
        const db = await this.#database;
        return new Promise((resolve, reject) => {
            const tx = db.transaction("walletRecords", "readonly"),
                request = tx
                    .objectStore("walletRecords")
                    .count(IDBKeyRange.bound(prefix, prefix + "\uffff"));
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(Error("IndexedDB count failed"));
            tx.onabort = () => reject(Error("IndexedDB count aborted"));
        });
    }
    async readPage(prefix: string, after: string | undefined, limit: number): Promise<RecordRow[]> {
        pageLimit(limit);
        const db = await this.#database;
        return new Promise((resolve, reject) => {
            const tx = db.transaction("walletRecords", "readonly"),
                store = tx.objectStore("walletRecords");
            const rows: RecordRow[] = [];
            const cursor = store.openCursor(
                IDBKeyRange.bound(after ?? prefix, prefix + "\uffff", !!after, false)
            );
            cursor.onsuccess = () => {
                const item = cursor.result;
                if (!item || rows.length >= limit) return;
                const value = item.value as AtomicRecord;
                rows.push({
                    key: String(item.key),
                    revision: value.revision,
                    data: Uint8Array.from(value.data),
                });
                if (rows.length < limit) item.continue();
            };
            tx.oncomplete = () => resolve(rows);
            tx.onerror = () => reject(new Error("IndexedDB page read failed"));
            tx.onabort = () => reject(new Error("IndexedDB page read aborted"));
        });
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
        const db = await this.#database;
        return new Promise((resolve, reject) => {
            const tx = db.transaction("walletRecords", "readwrite"),
                store = tx.objectStore("walletRecords"),
                request = store.get(key);
            let swapped = false;
            request.onsuccess = () => {
                if (
                    ((request.result as AtomicRecord | undefined)?.revision ?? 0) !==
                    previousRevision
                )
                    return;
                for (const write of writes) {
                    if (write.record)
                        store.put(
                            {
                                revision: write.record.revision,
                                data: Uint8Array.from(write.record.data),
                            },
                            write.key
                        );
                    else store.delete(write.key);
                }
                store.put({ revision: next.revision, data: Uint8Array.from(next.data) }, key);
                swapped = true;
            };
            tx.oncomplete = () => resolve(swapped);
            tx.onerror = () => reject(new Error("wallet IndexedDB transaction failed"));
            tx.onabort = () => reject(new Error("wallet IndexedDB transaction aborted"));
        });
    }
    async close(): Promise<void> {
        (await this.#database).close();
    }
}
export class IndexedDBWalletStore extends TransactionalWalletStore {
    readonly #records: IndexedDBAtomicRecords;
    constructor(
        name: string,
        codec: WalletRecordCodec,
        factory?: IDBFactory,
        options: { recentRecords?: number } = {}
    ) {
        const records = new IndexedDBAtomicRecords(name, factory);
        super(
            records,
            codec,
            { persistent: true, ...options },
            { owner: factory ?? indexedDB, namespace: name }
        );
        this.#records = records;
    }
    close(): Promise<void> {
        return this.#records.close();
    }
}

/** Separate database by default; hosts may also supply their own AtomicRecordStore. */
export class IndexedDBPublicHistoryStore extends PublicHistoryStore {
    readonly #records: IndexedDBAtomicRecords;
    constructor(
        name: string,
        factory?: IDBFactory,
        options: { retention?: Partial<PublicHistoryRetention> } = {}
    ) {
        const records = new IndexedDBAtomicRecords(name + "/public-history", factory);
        super(records, { persistent: true, ...options });
        this.#records = records;
    }
    close() {
        return this.#records.close();
    }
}
