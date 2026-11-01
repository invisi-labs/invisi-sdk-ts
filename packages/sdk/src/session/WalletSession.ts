import { Wallet } from "@invisi-labs/core";
import { prepareWithErrors } from "../errors";
import { copyGasBenchmarks } from "../gas-estimation";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { getAddress, type TransactionRequest, type TransactionResponse } from "ethers";

import { MissingCapabilityError } from "@invisi-labs/core";
import type { Protocol, TransactionCall } from "@invisi-labs/protocol";
import { Operation } from "./Operation";
import type {
    CancelCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    OperationRuntime,
    ShieldPreparation,
    TopUpCreditPreparation,
    TransferPreparation,
    WalletSessionOptions,
    WalletSessionInfrastructure,
} from "./operation-types";
import { TransactionPreparation } from "./transaction-preparation";
import { walletBalance, type WalletScope } from "./state";
import { scopeKey } from "./store";
import { refreshWallet, type RefreshOptions } from "./refresh";
import { WalletUpdater } from "./WalletUpdater";

/** Native ethers transaction options; the exported business call and session chain remain fixed. */
export type SessionTransactionOptions = Omit<
    TransactionRequest,
    "to" | "from" | "data" | "value" | "chainId"
>;

/** Wallet state and operations, with infrastructure and permissions explicitly injected. */
export class WalletSession {
    readonly #options: WalletSessionInfrastructure;
    #updater: WalletUpdater | undefined;
    readonly #sending = new Set<string>();
    #refreshQueue: Promise<unknown> = Promise.resolve();
    readonly scope: WalletScope;
    readonly protocol: Protocol;

    constructor(options: WalletSessionOptions) {
        if ("ciphertextCodecs" in options || "envelopeVersion" in options) {
            throw new Error(
                "SDK envelope versions are fixed; encode application payload bytes externally"
            );
        }
        this.#options = {
            ...options,
            ...(options.gasBenchmarks
                ? { gasBenchmarks: copyGasBenchmarks(options.gasBenchmarks) }
                : {}),
        };
        this.protocol = options.protocol;
        this.scope = Object.freeze({
            namespace: options.namespace ?? "default",
            ...options.protocol.context,
            walletIdentity: options.wallet.walletIdentity,
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

    async balance(tokenAddress: `0x${string}`) {
        const store = this.#options.store;
        if (!store) {
            throw new MissingCapabilityError("wallet store");
        }
        return walletBalance(await store.readSnapshot(this.scope), getAddress(tokenAddress) as Hex);
    }

    /** Pull explicitly selected indexed pages; no chain scanning or public tree reconstruction. */
    async refresh(options: RefreshOptions) {
        const provider = this.#options.protocolRpc;
        const reader = this.#options.chainReader;
        if (!reader) throw new MissingCapabilityError("chain reader");
        if (!provider) throw new MissingCapabilityError("Protocol RPC");
        const updater = this.updater();
        const request = {
            ...options,
            ...(options.detectionKey ? { detectionKey: options.detectionKey.slice() } : {}),
        };
        const task = this.#refreshQueue.then(() =>
            refreshWallet(
                {
                    provider,
                    reader,
                    context: this.protocol.context,
                    fromBlock: this.protocol.deployment.protocol.fromBlock,
                    apply: (batch, settings) => updater.applyUpdates(batch, settings),
                },
                request
            )
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
            authorization: runtime.authorization,
            readInventory: () => runtime.store.readSnapshot(runtime.scope),
            complete: (plan) => Operation.prepare(runtime, plan),
        });
    }
    async prepareTransfer(options: TransferPreparation): Promise<Operation> {
        return prepareWithErrors("prepareTransfer", async () => {
            return this.preparation(options.tokenAddress).prepareTransfer(options);
        });
    }
    async prepareShield(options: ShieldPreparation): Promise<Operation> {
        return prepareWithErrors("prepareShield", async () => {
            return this.preparation(options.tokenAddress).prepareShield(options);
        });
    }
    async prepareCreateCredit(options: CreateCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareCreateCredit", async () => {
            return this.preparation(options.tokenAddress).prepareCreateCredit(options);
        });
    }
    async prepareDrawCredit(options: DrawCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareDrawCredit", async () => {
            return this.preparation(options.tokenAddress).prepareDrawCredit(options);
        });
    }
    async prepareTopUpCredit(options: TopUpCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareTopUpCredit", async () => {
            return this.preparation(options.tokenAddress).prepareTopUpCredit(options);
        });
    }
    async prepareCancelCredit(options: CancelCreditPreparation): Promise<Operation> {
        return prepareWithErrors("prepareCancelCredit", async () => {
            return this.preparation(options.tokenAddress).prepareCancelCredit(options);
        });
    }
    async resume(operationId: string): Promise<Operation> {
        const store = this.#options.store;
        if (!store) throw new MissingCapabilityError("wallet store");
        const state = await store.readSnapshot(this.scope);
        const saved = state.operations[operationId]?.payload as
            { plan?: OperationPlan } | undefined;
        if (!saved?.plan) throw new Error("operation not found");
        return Operation.resume(this.runtime(saved.plan.context.tokenAddress), operationId);
    }

    toJSON() {
        return { walletSession: true, walletIdentity: this.scope.walletIdentity };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
