import {
    TransactionalWalletStore,
    type AtomicRecord,
    type AtomicRecordStore,
    type WalletRecordCodec,
} from "../session";
/** Native IndexedDB CAS transactions. Encryption happens outside active IDB transactions. */
export class IndexedDBAtomicRecords implements AtomicRecordStore {
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
    async compareAndSwap(
        key: string,
        previousRevision: number,
        next: AtomicRecord
    ): Promise<boolean> {
        const db = await this.#database;
        return new Promise((resolve, reject) => {
            const tx = db.transaction("walletRecords", "readwrite"),
                store = tx.objectStore("walletRecords"),
                request = store.get(key);
            let swapped = false;
            request.onsuccess = () => {
                if (
                    ((request.result as AtomicRecord | undefined)?.revision ?? 0) ===
                    previousRevision
                ) {
                    store.put({ revision: next.revision, data: Uint8Array.from(next.data) }, key);
                    swapped = true;
                }
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
    constructor(name: string, codec: WalletRecordCodec, factory?: IDBFactory) {
        const records = new IndexedDBAtomicRecords(name, factory);
        super(records, codec, { persistent: true });
        this.#records = records;
    }
    close(): Promise<void> {
        return this.#records.close();
    }
}
