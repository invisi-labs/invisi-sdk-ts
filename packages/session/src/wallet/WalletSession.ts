import { Wallet } from "@invisi-labs/core";
import { prepareWalletRefresh } from "../sync/WalletRefresh";
import type { Hex } from "@invisi-labs/protocol/contracts";
import {
    configureTransactionInfrastructure,
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
        ];
        for (const key of Object.keys(configuration)) {
            if (!allowed.includes(key))
                throw new TypeError(
                    `Unknown session option: ${key}; configure infrastructure on Invisi`
                );
        }
        if (!(configuration.wallet instanceof Wallet))
            throw new TypeError("public Wallet required");
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
        };
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

    /** Stage indexed pages; inject App decryption to validate and atomically commit state. */
    async refresh(options: RefreshOptions) {
        await this.ready();
        const provider = this.#options.protocolRpc;
        const reader = this.#options.chainReader;
        if (!reader) throw new MissingCapabilityError("chain reader");
        if (!provider) throw new MissingCapabilityError("Protocol RPC");
        if (!this.#options.store) throw new MissingCapabilityError("wallet store");
        const request = {
            ...options,
            ...(options.detectionKey ? { detectionKey: options.detectionKey.slice() } : {}),
        };
        const task = this.#refreshQueue.then(() =>
            prepareWalletRefresh(this.#options, this.scope, request)
        );
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
