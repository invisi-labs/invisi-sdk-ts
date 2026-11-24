import type { WalletScope, WalletStore } from "./state";

interface WriteWindow {
    writers: number;
    observers: number;
    epoch: object;
}

// Store handles sharing a backend in this JS context observe one another. Entries
// exist only while a transaction or a finite first-send observer is active.
const walletWriteWindows = new WeakMap<object, Map<string, WriteWindow>>();
export class WalletWriteObservation {
    readonly #writeWindows: Map<string, WriteWindow>;
    constructor(
        owner: object,
        private readonly keyOf: (scope: WalletScope) => string,
        private readonly namespace = ""
    ) {
        this.#writeWindows = walletWriteWindows.get(owner) ?? new Map();
        walletWriteWindows.set(owner, this.#writeWindows);
    }
    #writeWindow(scope: WalletScope) {
        const key = this.namespace + ":" + this.keyOf(scope);
        const window = this.#writeWindows.get(key) ?? { writers: 0, observers: 0, epoch: {} };
        this.#writeWindows.set(key, window);
        return {
            window,
            release: () => {
                if (!window.writers && !window.observers) this.#writeWindows.delete(key);
            },
        };
    }
    observeWrites(scope: WalletScope) {
        const { window, release } = this.#writeWindow(scope);
        const epoch = window.epoch;
        if (window.writers) throw Error("wallet write in progress during submission");
        window.observers++;
        let closed = false;
        return {
            assertCurrent() {
                if (closed || window.epoch !== epoch || window.writers)
                    throw Error("wallet changed during submission");
            },
            close() {
                if (closed) return;
                closed = true;
                window.observers--;
                release();
            },
        };
    }
    async write<T>(scope: WalletScope, work: () => Promise<T>): Promise<T> {
        const { window, release } = this.#writeWindow(scope);
        window.epoch = {};
        window.writers++;
        try {
            return await work();
        } finally {
            window.writers--;
            release();
        }
    }
}

/** SDK-originated writes through distinct sessions sharing a custom adapter
 * are observable even if that adapter cannot report external writes itself.
 */
export function withObservedWrites(
    store: WalletStore,
    keyOf: (scope: WalletScope) => string
): WalletStore {
    if (store.observeWrites) return store;
    const writes = new WalletWriteObservation(store, keyOf);
    return {
        persistent: store.persistent,
        readSnapshot: (scope) => store.readSnapshot(scope),
        ...(store.readSummary
            ? { readSummary: (scope: WalletScope) => store.readSummary!(scope) }
            : {}),
        ...(store.readRecords ? { readRecords: store.readRecords.bind(store) } : {}),
        ...(store.restoreReorgedOperations
            ? {
                  restoreReorgedOperations: (scope: WalletScope, from: bigint) =>
                      writes.write(scope, () => store.restoreReorgedOperations!(scope, from)),
              }
            : {}),
        transaction: (scope, action) => writes.write(scope, () => store.transaction(scope, action)),
        observeWrites: (scope) => writes.observeWrites(scope),
    };
}
