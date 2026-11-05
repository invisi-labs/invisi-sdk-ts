import { Wallet } from "@invisi-labs/core";
import type { Hex } from "@invisi-labs/protocol/contracts";
import {
    configureTransactionInfrastructure,
    copyGasBenchmarks,
    prepareWithErrors,
    validateTransactionInfrastructure,
} from "@invisi-labs/sdk/session-support";
import { getAddress, type TransactionRequest, type TransactionResponse } from "ethers";
import { walletHistory, type HistoryOptions } from "../history/history";

import { MissingCapabilityError } from "@invisi-labs/core";
import type { Protocol, TransactionCall } from "@invisi-labs/protocol";
import { TransactionPreparation } from "@invisi-labs/sdk/session-support";
import { Operation } from "../operations/Operation";
import type {
    CancelCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    OperationRuntime,
    ShieldPreparation,
    TopUpCreditPreparation,
    TransferPreparation,
    WalletSessionInfrastructure,
    WalletSessionOptions,
} from "../operations/operation-types";
import { walletBalance, type WalletScope } from "../storage/state";
import { scopeKey } from "../storage/store";
import { refreshWallet, type RefreshOptions } from "../sync/refresh";
import { WalletUpdater } from "../sync/WalletUpdater";

/** Native ethers transaction options; the exported business call and session chain remain fixed. */
export type SessionTransactionOptions = Omit<
    TransactionRequest,
    "to" | "from" | "data" | "value" | "chainId"
>;

/** Wallet state and operations, with infrastructure and permissions explicitly injected. */
export class WalletSession {
    readonly #options: WalletSessionInfrastructure;
    #updater: WalletUpdater | undefined;
    readonly #listeners = new Set<() => void>();
    readonly #sending = new Set<string>();
    #refreshQueue: Promise<unknown> = Promise.resolve();
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
            "viewing",
            "authorization",
            "fundingSigner",
            "coinSelector",
        ];
        for (const key of Object.keys(configuration)) {
            if (!allowed.includes(key))
                throw new TypeError(
                    `Unknown session option: ${key}; configure infrastructure on Invisi`
                );
        }
        const { invisi, ...local } = configuration;
        const options: WalletSessionInfrastructure = configureTransactionInfrastructure({
            ...invisi.getInfrastructure(),
            ...local,
        });
        const store = options.store;
        this.#options = {
            ...options,
            ...(store
                ? {
                      store: {
                          persistent: store.persistent,
                          readSnapshot: (scope) => store.readSnapshot(scope),
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
            ...(options.gasBenchmarks
                ? { gasBenchmarks: copyGasBenchmarks(options.gasBenchmarks) }
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
        const operation = input instanceof Operation ? input : undefined;
        if (operation && this.#sending.has(operation.id))
            throw new Error("operation is already being sent by this session");
        if (operation) this.#sending.add(operation.id);
        // Copy options and plain calldata before the first asynchronous provider check.
        const overrides = { ...options };
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
            authorization: () => {
                if (options.authorization) return options.authorization;
                if (options.wallet instanceof Wallet) return options.wallet.exportAuthorization();
                throw new MissingCapabilityError("wallet authorization");
            },
        };
    }

    private updater(): WalletUpdater {
        if (this.#updater) return this.#updater;
        const options = this.#options;
        if (!options.store || !options.chainReader || !options.protocolRpc)
            throw new MissingCapabilityError("wallet store, chain reader and Protocol RPC");
        const viewing =
            options.viewing ??
            (options.wallet instanceof Wallet ? options.wallet.getViewer() : undefined);
        if (!viewing) throw new MissingCapabilityError("viewing");
        const receivingAddress = options.wallet.getReceivingAddress();
        const receivingKeys =
            receivingAddress.kind === "long" ? receivingAddress.getReceivingKeys() : undefined;
        this.#updater = new WalletUpdater({
            protocol: options.protocol,
            scope: this.scope,
            store: options.store,
            reader: options.chainReader,
            viewing,

            protocolRpc: options.protocolRpc,
            ...(receivingKeys ? { receivingKeys } : {}),
        });
        return this.#updater;
    }

    /** Local session commits only. Host applications own cross-tab/store subscriptions. */
    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => {
            this.#listeners.delete(listener);
        };
    }

    /** Detached history for wallet UI; construction records do not imply chain success. */
    async getHistory(options: HistoryOptions = {}) {
        await this.ready();
        const tokenAddress = options.tokenAddress
            ? (getAddress(options.tokenAddress) as Hex)
            : undefined;
        const store = this.#options.store;
        if (!store) throw new MissingCapabilityError("wallet store");
        return walletHistory(
            await store.readSnapshot(this.scope),
            tokenAddress ? { tokenAddress } : {}
        );
    }

    async balance(tokenAddress: `0x${string}`) {
        await this.ready();
        const store = this.#options.store;
        if (!store) {
            throw new MissingCapabilityError("wallet store");
        }
        return walletBalance(await store.readSnapshot(this.scope), getAddress(tokenAddress) as Hex);
    }

    /** Pull explicitly selected indexed pages; no chain scanning or public tree reconstruction. */
    async refresh(options: RefreshOptions) {
        await this.ready();
        const provider = this.#options.protocolRpc;
        const reader = this.#options.chainReader;
        if (!reader) throw new MissingCapabilityError("chain reader");
        if (!provider) throw new MissingCapabilityError("Protocol RPC");
        const updater = this.updater();
        const request = {
            ...options,
            ...(options.detectionKey ? { detectionKey: options.detectionKey.slice() } : {}),
        };
        const task = this.#refreshQueue.then(async () => {
            const result = await refreshWallet(
                {
                    provider,
                    reader,
                    context: this.protocol.context,
                    fromBlock: this.protocol.deployment.protocol.fromBlock,
                    apply: (batch, settings) => updater.applyUpdates(batch, settings),
                },
                request
            );
            // Advance discovery only after every requested page succeeds. Reconciliation may
            // observe newer blocks without enumerating any incoming transactions.
            await this.#options.store!.transaction(this.scope, (state) => {
                request.signal?.throwIfAborted();
                if (state.invalidated) throw new Error("wallet requires canonical resync");
                const previous = state.discoveryThrough;
                const start = previous
                    ? previous.number + 1n
                    : this.protocol.deployment.protocol.fromBlock;
                if (
                    request.fromBlock <= start &&
                    (!previous || result.block.number >= previous.number)
                ) {
                    state.discoveryThrough = {
                        number: result.block.number,
                        hash: result.block.hash,
                    };
                }
            });
            return result;
        });
        this.#refreshQueue = task.catch(() => {});
        return task;
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
    async prepareTopUpCredit(options: TopUpCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareTopUpCredit", async () => {
            await this.ready();
            return this.preparation(options.tokenAddress).prepareTopUpCredit(options);
        });
    }
    async prepareCancelCredit(options: CancelCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareCancelCredit", async () => {
            await this.ready();
            return this.preparation(options.tokenAddress).prepareCancelCredit(options);
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
