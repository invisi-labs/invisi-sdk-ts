import { FIELD_MODULUS, normalizeCreditDeliveryState } from "@invisi-labs/primitives";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { WalletScope, WalletState, WalletStore } from "./state";
import { creditReservationKey } from "./state";
export function scopeKey(scope: WalletScope): string {
    if (
        typeof scope.namespace !== "string" ||
        !scope.namespace.length ||
        scope.namespace.length > 256
    )
        throw new Error("invalid wallet namespace");
    if (typeof scope.chainId !== "bigint" || scope.chainId < 0n || scope.chainId >= 1n << 64n)
        throw new Error("invalid scope chain");
    for (const address of [scope.protocolAddress])
        if (!/^0x[0-9a-fA-F]{40}$/.test(address) || BigInt(address) === 0n)
            throw new Error("invalid scope deployment");
    if (
        !/^0x[0-9a-fA-F]{40}$/.test(scope.ownerAddress) ||
        BigInt(scope.ownerAddress) <= 0n ||
        BigInt(scope.ownerAddress) >= 1n << 160n
    )
        throw new Error("invalid scope wallet");
    return bytesToHex(
        sha256(
            utf8ToBytes(
                "Invisi.WalletScope.v1:" +
                    JSON.stringify([
                        scope.namespace,
                        scope.chainId.toString(),
                        scope.protocolAddress.toLowerCase(),
                        scope.ownerAddress.toLowerCase(),
                    ])
            )
        )
    );
}
export function initialState(scope: WalletScope): WalletState {
    scopeKey(scope);
    return {
        schemaVersion: 2,
        scope: { ...scope },
        revision: 0,
        notes: {},
        credits: {},
        reservations: {},
        operations: {},
    };
}
export function validateState(state: WalletState, scope: WalletScope, revision: number): void {
    if (
        !state ||
        state.schemaVersion !== 2 ||
        scopeKey(state.scope) !== scopeKey(scope) ||
        state.revision !== revision
    )
        throw new Error("wallet state scope/schema/revision mismatch");
    if (!Number.isSafeInteger(revision) || revision < 0)
        throw new Error("invalid wallet state revision");
    for (const field of [state.notes, state.credits, state.reservations, state.operations])
        if (!field || typeof field !== "object" || Array.isArray(field))
            throw new Error("invalid wallet state records");
    for (const record of Object.values(state.notes)) {
        if (
            typeof record.note.tokenAddress !== "bigint" ||
            record.note.tokenAddress <= 0n ||
            record.note.tokenAddress >= 1n << 160n ||
            record.note.chainId !== scope.chainId ||
            record.note.protocolAddress !== BigInt(scope.protocolAddress) ||
            record.note.ownerAddress.toLowerCase() !== scope.ownerAddress.toLowerCase() ||
            typeof record.note.amount !== "bigint" ||
            record.note.amount <= 0n ||
            record.note.amount >= 1n << 128n
        )
            throw new Error("invalid stored note context or amount");
        if (!["unspent", "unknown", "spent"].includes(record.spent))
            throw new Error("invalid spent state");
    }
    for (const record of Object.values(state.credits)) {
        const note = normalizeCreditDeliveryState(record.state).note;
        if (
            note.chainId !== scope.chainId ||
            note.protocolAddress !== BigInt(scope.protocolAddress) ||
            !["owner", "spender"].includes(record.role) ||
            (record.role === "owner"
                ? note.ownerWalletIdentity
                : note.spenderWalletIdentity
            ).toLowerCase() !== scope.ownerAddress.toLowerCase() ||
            !["unspent", "unknown", "spent"].includes(record.spent)
        )
            throw new Error("invalid stored Credit context or role");
    }
    for (const record of [...Object.values(state.notes), ...Object.values(state.credits)]) {
        if (
            !/^0x[0-9a-fA-F]{64}$/.test(record.commitment) ||
            BigInt(record.commitment) <= 0n ||
            BigInt(record.commitment) >= FIELD_MODULUS ||
            typeof record.treeId !== "bigint" ||
            record.treeId < 1n ||
            record.treeId >= 1n << 64n ||
            !Number.isInteger(record.leafIndex) ||
            record.leafIndex < 0 ||
            record.leafIndex >= 65536 ||
            typeof record.blockNumber !== "bigint" ||
            record.blockNumber < 0n ||
            !/^0x[0-9a-fA-F]{64}$/.test(record.blockHash)
        )
            throw new Error("invalid stored receipt position");
    }
    for (const [id, operation] of Object.entries(state.reservations))
        if (
            !state.operations[operation] ||
            (!state.notes[id] &&
                !Object.values(state.credits).some(
                    (record) => creditReservationKey(record.commitment) === id
                ) &&
                !["submitted", "uncertain", "reorged"].includes(
                    state.operations[operation]!.status
                ))
        )
            throw new Error("orphan input reservation");
}
/** A stored encrypted blob and its CAS revision. No private state is exposed to adapters. */
export interface AtomicRecord {
    revision: number;
    data: Uint8Array;
}
export interface AtomicRecordStore {
    read(key: string): Promise<AtomicRecord | undefined>;
    compareAndSwap(key: string, previousRevision: number, next: AtomicRecord): Promise<boolean>;
}
export interface WalletRecordCodec {
    encode(value: WalletState, context: { key: string; revision: number }): Promise<Uint8Array>;
    decode(data: Uint8Array, context: { key: string; revision: number }): Promise<WalletState>;
}
export class TransactionalWalletStore implements WalletStore {
    readonly persistent: boolean;
    readonly #records: AtomicRecordStore;
    readonly #codec: WalletRecordCodec;
    constructor(
        records: AtomicRecordStore,
        codec: WalletRecordCodec,
        options: { persistent: boolean }
    ) {
        this.#records = records;
        this.#codec = codec;
        this.persistent = options.persistent;
    }
    async readSnapshot(scope: WalletScope): Promise<WalletState> {
        const key = scopeKey(scope),
            record = await this.#records.read(key);
        if (!record) return initialState(scope);
        const state = await this.#codec.decode(record.data, { key, revision: record.revision });
        validateState(state, scope, record.revision);
        return state;
    }
    async transaction<T>(scope: WalletScope, action: (draft: WalletState) => T): Promise<T> {
        if (action.constructor.name === "AsyncFunction")
            throw new Error("wallet transaction action must be synchronous");
        const copied = { ...scope },
            key = scopeKey(copied);
        for (let attempt = 0; attempt < 100; attempt++) {
            const draft = await this.readSnapshot(copied),
                previous = draft.revision;
            const result = action(draft);
            if (result && typeof result === "object" && "then" in result) {
                Promise.resolve(result).catch(() => {});
                throw new Error("wallet transaction action must be synchronous");
            }
            validateState(draft, copied, previous);
            if (!Number.isSafeInteger(previous + 1))
                throw new Error("wallet state revision exhausted");
            draft.revision = previous + 1;
            const data = await this.#codec.encode(draft, { key, revision: draft.revision });
            if (
                await this.#records.compareAndSwap(key, previous, {
                    revision: draft.revision,
                    data,
                })
            )
                return result;
        }
        throw new Error("wallet transaction contention limit exceeded");
    }
    toJSON() {
        return { walletStore: true, persistent: this.persistent };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
/** Explicitly nonpersistent reference storage; data never leaves this process. */
export class MemoryAtomicRecords implements AtomicRecordStore {
    readonly #values = new Map<string, AtomicRecord>();
    async read(key: string): Promise<AtomicRecord | undefined> {
        const value = this.#values.get(key);
        return value ? { revision: value.revision, data: Uint8Array.from(value.data) } : undefined;
    }
    async compareAndSwap(
        key: string,
        previousRevision: number,
        next: AtomicRecord
    ): Promise<boolean> {
        if ((this.#values.get(key)?.revision ?? 0) !== previousRevision) return false;
        this.#values.set(key, { revision: next.revision, data: Uint8Array.from(next.data) });
        return true;
    }
}
