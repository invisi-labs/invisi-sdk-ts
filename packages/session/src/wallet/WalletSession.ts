import { scanStatus, fundsStatus } from "../sync/status";
import { PublicHistory, historyScope, type PublicSyncOptions } from "../public-history/history";
import { PublicHistoryStore, publicScopeKey } from "../public-history/store";
import { MemoryAtomicRecords } from "../storage/store";
import {
    scanAccount,
    retryUnresolved,
    fenceHistory,
    type AccountScanOptions,
} from "../public-history/scan";
import type { DeliveryDecryptor } from "@invisi-labs/primitives";
import { Wallet } from "@invisi-labs/primitives";
import { prepareWalletRefresh } from "../sync/WalletRefresh";
import type { Hex } from "@invisi-labs/protocol/contracts";
import {
    configureTransactionInfrastructure,
    prepareWithErrors,
    validateTransactionInfrastructure,
} from "@invisi-labs/sdk/session-support";
import { getAddress, getBigInt, type TransactionRequest, type TransactionResponse } from "ethers";
import { walletHistory, type HistoryOptions } from "../history/history";

import { MissingCapabilityError } from "@invisi-labs/primitives";
import type { Protocol } from "@invisi-labs/rpc";
import type { TransactionCall } from "@invisi-labs/protocol";
import { TransactionPreparation } from "@invisi-labs/sdk/session-support";
import { Operation } from "../operations/Operation";
import type {
    RevokeCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    OperationRuntime,
    ShieldPreparation,
    UpdateCreditPreparation,
    TransferPreparation,
    WalletSessionInfrastructure,
    WalletSessionOptions,
} from "../operations/operation-types";
import { walletBalance, type WalletScope } from "../storage/state";
import { scopeKey } from "../storage/store";
import { type RefreshOptions } from "../sync/refresh";

const sharedHistory = new WeakMap<object, Map<string, PublicHistory>>();

/** Native ethers transaction options; the exported business call and session chain remain fixed. */
export type SessionTransactionOptions = Omit<
    TransactionRequest,
    "to" | "from" | "data" | "value" | "chainId"
>;

/** Wallet state and operations, with infrastructure and permissions explicitly injected. */
export class WalletSession {
    readonly #options: WalletSessionInfrastructure;
    readonly #listeners = new Set<() => void>();
    readonly #sending = new Set<string>();
    #refreshQueue: Promise<unknown> = Promise.resolve();
    #scanQueue: Promise<unknown> = Promise.resolve();
    #history: PublicHistory | undefined;
    readonly scope: WalletScope;
    readonly protocol: Protocol;

    static async connect(options: WalletSessionOptions): Promise<WalletSession> {
        const session = new WalletSession(options);
        await session.ready();
        return session;
    }

    #validation: Promise<void> | undefined;

    private ready(): Promise<void> {
        if (!this.#validation) {
            this.#validation = validateTransactionInfrastructure(this.#options).catch((error) => {
                this.#validation = undefined;
                throw error;
            });
        }
        return this.#validation;
    }

    constructor(configuration: WalletSessionOptions) {
        const allowed = [
            "invisi",
            "wallet",
            "protocol",
            "namespace",
            "store",
            "signer",
            "fundingSigner",
            "coinSelector",
            "publicHistory",
        ];
        for (const key of Object.keys(configuration)) {
            if (!allowed.includes(key))
                throw new TypeError(
                    `Unknown session option: ${key}; configure infrastructure on Invisi`
                );
        }
        if (!(configuration.wallet instanceof Wallet))
            throw new TypeError("public Wallet required");
        const { invisi, publicHistory, ...local } = configuration;
        const options: WalletSessionInfrastructure = configureTransactionInfrastructure({
            ...invisi.getInfrastructure(),
            ...local,
        });
        let history = publicHistory;
        const key = publicScopeKey(historyScope(options.protocol));
        if (history && history.key !== key) throw Error("public history deployment mismatch");
        if (!history && options.chainReader && options.protocolRpc) {
            let deployments = sharedHistory.get(invisi);
            if (!deployments) {
                deployments = new Map();
                sharedHistory.set(invisi, deployments);
            }
            history = deployments.get(key);
            if (!history) {
                history = new PublicHistory({
                    store: new PublicHistoryStore(new MemoryAtomicRecords(), { persistent: false }),
                    protocol: options.protocol,
                    reader: options.chainReader,
                    protocolRpc: options.protocolRpc,
                });
                deployments.set(key, history);
            }
        }
        this.#history = history;
        const store = options.store;
        this.#options = {
            ...options,
            ...(store
                ? {
                      store: {
                          persistent: store.persistent,
                          readSnapshot: (scope) =>
                              history
                                  ? fenceHistory(history, store, scope)
                                  : store.readSnapshot(scope),
                          ...(store.restoreReorgedOperations
                              ? {
                                    restoreReorgedOperations: (scope: WalletScope, from: bigint) =>
                                        store.restoreReorgedOperations!(scope, from),
                                }
                              : {}),
                          ...(store.readSummary
                              ? {
                                    readSummary: (scope: WalletScope) =>
                                        history
                                            ? fenceHistory(history, store, scope, true)
                                            : store.readSummary!(scope),
                                }
                              : {}),
                          ...(store.readRecords
                              ? {
                                    readRecords: (
                                        scope: WalletScope,
                                        query: import("../storage/record-wallet").WalletRecordQuery
                                    ) => store.readRecords!(scope, query),
                                }
                              : {}),
                          transaction: async (scope, action) => {
                              const result = await store.transaction(scope, action);
                              if (scopeKey(scope) === scopeKey(this.scope)) {
                                  for (const listener of [...this.#listeners]) {
                                      try {
                                          listener();
                                      } catch {
                                          // UI observers must not turn a committed write into a failure.
                                      }
                                  }
                              }
                              return result;
                          },
                      },
                  }
                : {}),
        };
        this.protocol = options.protocol;
        this.scope = Object.freeze({
            namespace: options.namespace ?? "default",
            ...options.protocol.context,
            ownerAddress: options.wallet.ownerAddress,
        });
        scopeKey(this.scope);
        Object.freeze(this);
    }

    async sendTransaction(
        call: TransactionCall,
        options?: SessionTransactionOptions
    ): Promise<TransactionResponse>;
    async sendTransaction(
        operation: Operation,
        options?: SessionTransactionOptions
    ): Promise<TransactionResponse>;
    /** Delegate sending to ethers; managed operations additionally retain the resulting hash. */
    async sendTransaction(
        input: TransactionCall | Operation,
        options: SessionTransactionOptions = {}
    ): Promise<TransactionResponse> {
        const signer = this.#options.signer;
        if (!signer) throw new MissingCapabilityError("ethers signer");
        const overrides = { ...options };
        // A supplied budget prevents ethers from implicitly simulating the transaction.
        if (overrides.gasLimit == null || getBigInt(overrides.gasLimit, "gasLimit") <= 0n)
            throw new Error("transaction gas limit must be supplied by the caller");
        const operation = input instanceof Operation ? input : undefined;
        if (operation && this.#sending.has(operation.id))
            throw new Error("operation is already being sent by this session");
        if (operation) this.#sending.add(operation.id);
        // Copy plain calldata before the first asynchronous provider check.
        const plain = operation ? undefined : { ...(input as TransactionCall) };
        try {
            await this.ready();
            if (!signer.provider) throw new MissingCapabilityError("connected ethers signer");
            if ((await signer.provider.getNetwork()).chainId !== this.protocol.context.chainId) {
                throw new Error("signer-provider session chain mismatch");
            }
            if (operation) {
                if (!this.#options.store) throw new MissingCapabilityError("wallet store");
                const state = await this.#options.store.readSnapshot(this.scope);
                if (!state.operations[operation.id])
                    throw new Error("operation does not belong to this wallet session");
            }
            const call = operation ? await operation.exportTransaction() : plain!;
            const transaction = await signer.sendTransaction({
                ...overrides,
                to: call.to,
                data: call.data,
                value: call.value,
                chainId: this.protocol.context.chainId,
            });
            if (operation) {
                try {
                    await operation.trackTransaction(transaction.hash);
                } catch (cause) {
                    throw new Error(
                        `Transaction ${transaction.hash} was sent but its operation association could not be saved; resume and reconcile this hash`,
                        { cause }
                    );
                }
            }
            return transaction;
        } finally {
            if (operation) this.#sending.delete(operation.id);
        }
    }

    private runtime(tokenAddress: `0x${string}`): OperationRuntime {
        const options = this.#options;
        if (!options.store) {
            throw new MissingCapabilityError("wallet store");
        }
        if (!options.chainReader) {
            throw new MissingCapabilityError("chain reader");
        }
        return {
            options: { ...options, protocol: options.protocol.forToken(tokenAddress) },
            scope: this.scope,
            store: options.store,
            reader: options.chainReader,
        };
    }

    /** Local session commits only. Host applications own cross-tab/store subscriptions. */
    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Full detached history; prefer getHistoryPage for bounded UI reads. */
    async getHistory(options: HistoryOptions = {}) {
        await this.ready();
        const tokenAddress = options.tokenAddress
            ? (getAddress(options.tokenAddress) as Hex)
            : undefined;
        const store = this.#options.store;
        if (!store) throw new MissingCapabilityError("wallet store");
        if (store.readRecords && store.readSummary) {
            const state = await store.readSummary(this.scope);
            state.notes = {};
            state.operations = {};
            for (const kind of ["notes", "operations"] as const) {
                let cursor: string | undefined;
                do {
                    const page = await store.readRecords(this.scope, {
                        kind,
                        limit: 128,
                        ...(cursor ? { cursor } : {}),
                    });
                    if (page.revision !== state.revision)
                        throw Error("wallet history changed; retry");
                    for (const item of page.items) {
                        (state[kind] as Record<string, unknown>)[item.id] = item.value;
                        if (item.canonical === "unknown")
                            state.invalidated =
                                "Historical record requires canonical reconciliation";
                    }
                    cursor = page.nextCursor;
                } while (cursor);
            }
            return walletHistory(state, tokenAddress ? { tokenAddress } : {});
        }
        return walletHistory(
            await store.readSnapshot(this.scope),
            tokenAddress ? { tokenAddress } : {}
        );
    }

    async getHistoryPage(options: {
        direction: "incoming" | "outgoing";
        limit?: number;
        cursor?: string;
        tokenAddress?: Hex;
    }) {
        const store = this.#options.store;
        if (!store?.readRecords || !store.readSummary)
            throw new MissingCapabilityError("paged wallet store");
        const summary = await store.readSummary(this.scope);
        const page = await store.readRecords(this.scope, {
            kind: options.direction === "incoming" ? "notes" : "operations",
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
            ...(options.cursor ? { cursor: options.cursor } : {}),
        });
        if (page.revision !== summary.revision)
            throw Error("wallet history changed; restart pagination");
        const projection = { ...summary, notes: {}, credits: {}, operations: {}, reservations: {} };
        const items: {
            entry:
                | import("../history/history").IncomingHistoryEntry
                | import("../history/history").OutgoingHistoryEntry;
            archived: boolean;
            canonical: "current" | "unknown";
        }[] = [];
        for (const item of page.items) {
            if (options.direction === "incoming")
                projection.notes = {
                    [item.id]: item.value as import("../storage/state").StoredNote,
                };
            else
                projection.operations = {
                    [item.id]: item.value as import("../storage/state").OperationRecord,
                };
            const view = walletHistory(
                projection,
                options.tokenAddress
                    ? { tokenAddress: getAddress(options.tokenAddress) as Hex }
                    : {}
            );
            const entry = options.direction === "incoming" ? view.incoming[0] : view.outgoing[0];
            if (entry)
                items.push({
                    entry,
                    archived: item.archived,
                    canonical: summary.invalidated ? "unknown" : item.canonical,
                });
        }
        return {
            revision: page.revision,
            checkedThrough: summary.discoveryThrough ?? null,
            invalidated: !!summary.invalidated,
            items,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
    }

    async balance(tokenAddress: `0x${string}`) {
        await this.ready();
        const store = this.#options.store;
        if (!store) {
            throw new MissingCapabilityError("wallet store");
        }
        return walletBalance(await store.readSnapshot(this.scope), getAddress(tokenAddress) as Hex);
    }

    /** Stage indexed pages; inject App decryption to validate and atomically commit state. */
    async refresh(options: RefreshOptions = {}) {
        await this.ready();
        const provider = this.#options.protocolRpc;
        const reader = this.#options.chainReader;
        if (!reader) throw new MissingCapabilityError("chain reader");
        if (!provider) throw new MissingCapabilityError("Protocol RPC");
        if (!this.#options.store) throw new MissingCapabilityError("wallet store");
        const request = { ...options };
        const task = this.#refreshQueue.then(() =>
            prepareWalletRefresh(this.#options, this.scope, request, this.publicHistory)
        );
        this.#refreshQueue = task.catch(() => {});
        const pending = await task;
        return {
            block: pending.block,
            decrypt: (decryptor: DeliveryDecryptor) =>
                this.queueScan(() => pending.decrypt(decryptor)),
        };
    }

    get publicHistory(): PublicHistory {
        if (!this.#history) throw new MissingCapabilityError("public history infrastructure");
        return this.#history;
    }
    synchronizeHistory(options: PublicSyncOptions = {}) {
        return this.publicHistory.synchronize(options);
    }
    private queueScan<T>(action: () => Promise<T>): Promise<T> {
        const result = this.#scanQueue.then(action);
        this.#scanQueue = result.catch(() => {});
        return result;
    }
    scanHistory(decryptor: DeliveryDecryptor, options: AccountScanOptions = {}) {
        return this.queueScan(() =>
            scanAccount(this.publicHistory, this.#options, this.scope, decryptor, options)
        );
    }
    async getScanStatus() {
        if (!this.#options.store) throw new MissingCapabilityError("wallet store");
        const store = this.#options.store;
        const state = await (store.readSummary
            ? store.readSummary(this.scope)
            : store.readSnapshot(this.scope));
        const publicState = await this.publicHistory.snapshot();
        return scanStatus(state, publicState, this.publicHistory.scope);
    }
    async getFundsStatus(tokenAddress: Hex) {
        const store = this.#options.store;
        if (!store) throw new MissingCapabilityError("wallet store");
        const state = await store.readSnapshot(this.scope),
            history = await this.publicHistory.snapshot();
        return fundsStatus(
            state,
            getAddress(tokenAddress) as Hex,
            history.knownHead ?? history.indexedHead ?? history.coverage?.at(-1)?.block
        );
    }
    retryUnresolved(
        decryptor: DeliveryDecryptor,
        options: Omit<AccountScanOptions, "fromBlock" | "toBlock" | "reset"> = {}
    ) {
        return this.queueScan(() =>
            retryUnresolved(this.publicHistory, this.#options, this.scope, decryptor, options)
        );
    }
    async refreshState(
        options: {
            signal?: AbortSignal;
            onProgress?: import("../public-history/history").HistoryProgressListener;
        } = {}
    ) {
        if (!this.#options.store) throw new MissingCapabilityError("wallet store");
        const publicState = await this.publicHistory.snapshot();
        const target =
            publicState.knownHead ??
            publicState.indexedHead ??
            publicState.coverage?.at(-1)?.block ??
            publicState.through;
        if (!target) throw Error("synchronize public history before refreshing known state");
        const result = await this.scanHistory(
            {
                async decryptNote() {
                    throw Error("state refresh must not decrypt");
                },
                async decryptCredit() {
                    throw Error("state refresh must not decrypt");
                },
            },
            { ...options, fromBlock: target.number + 1n, toBlock: target.number }
        );
        const state = await this.#options.store!.readSnapshot(this.scope);
        for (const record of Object.values(state.operations)) {
            options.signal?.throwIfAborted();
            if (
                record.payload &&
                record.transactionHash &&
                ["submitted", "uncertain", "reorged"].includes(record.status)
            )
                await (await this.resume(record.id)).reconcile(options);
        }
        return result;
    }

    private preparation(tokenAddress: Hex): TransactionPreparation<Operation> {
        const runtime = this.runtime(tokenAddress);
        return new TransactionPreparation({
            options: runtime.options,
            scope: runtime.scope,
            reader: runtime.reader,
            readInventory: () => runtime.store.readSnapshot(runtime.scope),
            complete: (plan) => Operation.prepare(runtime, plan),
        });
    }
    async prepareTransfer(options: TransferPreparation): Promise<Operation> {
        return prepareWithErrors("prepareTransfer", async () => {
            await this.ready();
            return this.preparation(options.tokenAddress).prepareTransfer(options);
        });
    }
    async prepareShield(options: ShieldPreparation): Promise<Operation> {
        return prepareWithErrors("prepareShield", async () => {
            await this.ready();
            return this.preparation(options.tokenAddress).prepareShield(options);
        });
    }
    async prepareCreateCredit(options: CreateCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareCreateCredit", async () => {
            await this.ready();
            return this.preparation(options.tokenAddress).prepareCreateCredit(options);
        });
    }
    async prepareDrawCredit(options: DrawCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareDrawCredit", async () => {
            await this.ready();
            return this.preparation(options.tokenAddress).prepareDrawCredit(options);
        });
    }
    async prepareUpdateCredit(options: UpdateCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareUpdateCredit", async () => {
            await this.ready();
            return this.preparation(options.tokenAddress).prepareUpdateCredit(options);
        });
    }
    async prepareRevokeCredit(options: RevokeCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareRevokeCredit", async () => {
            await this.ready();
            return this.preparation(options.tokenAddress).prepareRevokeCredit(options);
        });
    }
    async resume(operationId: string): Promise<Operation> {
        await this.ready();
        await this.ready();
        const store = this.#options.store;
        if (!store) throw new MissingCapabilityError("wallet store");
        const state = await store.readSnapshot(this.scope);
        const saved = state.operations[operationId]?.payload as
            { plan?: OperationPlan } | undefined;
        if (!saved?.plan) throw new Error("operation not found");
        return Operation.resume(this.runtime(saved.plan.context.tokenAddress), operationId);
    }

    toJSON() {
        return { walletSession: true, ownerAddress: this.scope.ownerAddress };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
