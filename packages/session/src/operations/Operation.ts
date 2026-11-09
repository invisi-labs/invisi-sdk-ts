import {
    revocationSigningRequest,
    acceptRevocationSignature,
} from "@invisi-labs/sdk/session-support";
import { TransactionOutput } from "@invisi-labs/sdk/session-support";
import type { Hex } from "@invisi-labs/protocol/contracts";
import {
    acceptFundingSignature,
    acceptWalletSignature,
    authorizeOperation,
    getOperationGasReference,
    fundingSigningRequest,
    operationPreview,
    proveOperation,
    signOperationFunding,
    walletSigningRequest,
} from "@invisi-labs/sdk/session-support";
import { quoteManagedOperation } from "./broadcaster";
import { currentOperation, runOperationStage } from "./worker";

import { MissingCapabilityError, type AuthorizedStatement } from "@invisi-labs/core";
import { normalizeFunding, type TransactionCall } from "@invisi-labs/protocol";
import {
    encodeOperation,
    exportBroadcasterIntent,
    inputFacts,
    operationExpired,
    operationSources,
    publicProof,
    requiresAuthorization,
    sameStatement,
    statement,
} from "@invisi-labs/sdk/session-support";
import type { OperationRecord, OperationStatus } from "../storage/state";
import { scopeKey } from "../storage/store";
import { confirmOperation, reconcileOperation } from "./operation-confirmation";
import type {
    OperationAggregateMember,
    OperationPlan,
    OperationRuntime,
    SavedOperation,
    TransactionProveOptions,
} from "./operation-types";

function check(ok: unknown, message: string): asserts ok {
    if (!ok) {
        throw new Error(message);
    }
}

/** Immutable operation handle. No private plan, witness, or transaction is logged implicitly. */
export class Operation {
    readonly #runtime: OperationRuntime;
    readonly #saved: SavedOperation;
    readonly #authorization: AuthorizedStatement | undefined;
    readonly status: OperationStatus;

    private constructor(
        runtime: OperationRuntime,
        saved: SavedOperation,
        status: OperationStatus,
        authorization?: AuthorizedStatement
    ) {
        this.#runtime = runtime;
        this.#saved = structuredClone(saved);
        this.status = status;
        this.#authorization = authorization;
        Object.freeze(this);
    }

    static async prepare(runtime: OperationRuntime, plan: OperationPlan): Promise<Operation> {
        const saved: SavedOperation = { plan: structuredClone(plan), generation: 0 };
        await runtime.store.transaction(runtime.scope, (state) => {
            check(!state.invalidated, "wallet state requires canonical resync");
            check(!state.operations[plan.id], "operation already exists");
            const facts = inputFacts(plan);
            for (const input of facts) {
                const record = state[input.kind][input.key];
                check(
                    record &&
                        record.spent === "unspent" &&
                        !state.reservations[input.reservationKey],
                    "input unavailable or already reserved"
                );
            }
            state.operations[plan.id] = {
                id: plan.id,
                status: "prepared",
                inputs: facts.map((input) => input.reservationKey),
                deadline: plan.deadline,
                payload: saved,
            };
            for (const input of facts) {
                state.reservations[input.reservationKey] = plan.id;
            }
        });
        return new Operation(runtime, saved, "prepared");
    }

    static async resume(runtime: OperationRuntime, id: string): Promise<Operation> {
        const result = await runtime.store.transaction(runtime.scope, (state) => {
            const record = state.operations[id];
            check(record, "unknown operation");
            const saved = record.payload as SavedOperation;
            check(
                saved?.plan?.version === 1 &&
                    saved.plan.id === id &&
                    Number.isSafeInteger(saved.generation) &&
                    saved.generation >= 0 &&
                    saved.generation < Number.MAX_SAFE_INTEGER,
                "invalid operation payload"
            );
            const context = runtime.options.protocol.context;
            const actual = saved.plan.context;
            check(
                scopeKey(saved.plan.scope) === scopeKey(runtime.scope) &&
                    actual.chainId === context.chainId &&
                    actual.protocolAddress.toLowerCase() ===
                        context.protocolAddress.toLowerCase() &&
                    actual.tokenAddress.toLowerCase() === context.tokenAddress.toLowerCase(),
                "recovered operation scope/deployment context mismatch"
            );
            if (saved.plan.kind !== "shield" && saved.plan.kind !== "revoke-credit") {
                statement(saved.plan);
            }
            if (saved.proof) {
                sameStatement(saved.proof, saved.plan.statement!);
            }
            // Explicit recovery fences any former worker. Signing material is never restored from storage.
            saved.generation++;
            delete saved.claim;
            return new Operation(runtime, saved, record.status);
        });
        if (result.#saved.call) {
            const expected = await result.encode(result.#saved);
            check(
                expected.to === result.#saved.call.to &&
                    expected.value === result.#saved.call.value &&
                    expected.data === result.#saved.call.data,
                "recovered transaction differs from frozen operation"
            );
        }
        return result;
    }

    /** Public non-sendable intent for a firm quote before wallet authorization. */
    async exportBroadcasterIntent() {
        check(
            ["prepared", "authorized"].includes(this.status),
            "quote intent requires a prepared operation"
        );
        return exportBroadcasterIntent(this.#saved.plan);
    }
    broadcasterQuote() {
        return this.#saved.broadcasterQuote
            ? structuredClone(this.#saved.broadcasterQuote)
            : undefined;
    }
    async withBroadcaster(
        client: import("@invisi-labs/sdk").BroadcasterClient,
        options: import("@invisi-labs/sdk/session-support").WithBroadcasterOptions
    ): Promise<Operation> {
        check(this.status === "prepared", "broadcaster must attach before signing");
        const saved = await quoteManagedOperation(this.#runtime, this.#saved, client, options);
        return new Operation(this.#runtime, saved, "prepared");
    }
    get id(): string {
        return this.#saved.plan.id;
    }

    get kind(): OperationPlan["kind"] {
        return this.#saved.plan.kind;
    }

    async estimateGas(options: { from?: `0x${string}` } = {}) {
        const provider = this.#runtime.options.provider;
        if (!provider)
            throw new MissingCapabilityError("ethers provider for final eth_estimateGas");
        const call = await this.exportTransaction();
        return {
            source: "rpc" as const,
            gasUnits: await provider.estimateGas({ ...call, ...options }),
        };
    }
    getGasReference() {
        return getOperationGasReference(this.#saved.plan, this.#runtime.options.protocol);
    }
    /** Final Note outputs, including change. Credit openings have no IPN export. */
    getOutputs(): readonly TransactionOutput[] {
        return Object.freeze(
            this.#saved.plan.outputs.map((output) => new TransactionOutput(output))
        );
    }
    preview() {
        return operationPreview(this.#saved.plan, this.status);
    }

    private current(record: OperationRecord | undefined): SavedOperation {
        return currentOperation(record, this.#saved.generation);
    }

    private async stage(
        stage: string,
        allowed: OperationStatus[],
        work: (
            saved: SavedOperation
        ) => Promise<{ status: OperationStatus; authorization?: AuthorizedStatement }>,
        signal?: AbortSignal
    ): Promise<Operation> {
        const next = await runOperationStage(
            this.#runtime,
            this.#saved,
            stage,
            allowed,
            work,
            signal
        );
        return new Operation(
            this.#runtime,
            next.saved,
            next.status,
            next.authorization ?? this.#authorization
        );
    }

    private async signingCurrent(): Promise<void> {
        await this.#runtime.store.transaction(this.#runtime.scope, (state) => {
            check(!state.invalidated, "wallet state requires canonical resync");
            this.current(state.operations[this.id]);
        });
    }

    async exportRevocationAuthorization() {
        return revocationSigningRequest(this.#saved.plan, this.#runtime);
    }
    async withRevocationSignature(signature: `0x${string}`): Promise<Operation> {
        const verified = await acceptRevocationSignature(
            this.#saved.plan,
            signature,
            this.#runtime
        );
        return this.stage("revocation authorization", ["prepared"], async (saved) => {
            saved.plan.credit!.revocationSignature = verified;
            saved.call = await encodeOperation(saved);
            return { status: "ready" };
        });
    }
    /** Public EIP-712 request; signing transport and key custody belong to the caller. */
    async exportWalletAuthorization(options: { signal?: AbortSignal } = {}) {
        options.signal?.throwIfAborted();
        await this.signingCurrent();
        check(
            requiresAuthorization(this.#saved.plan),
            "operation does not require wallet authorization"
        );
        check(
            ["prepared", "authorized"].includes(this.status),
            "operation is not awaiting wallet authorization"
        );
        return walletSigningRequest(this.#saved.plan);
    }

    /** Attach an external EOA signature, retaining its witness only at the private proving boundary. */
    async withWalletSignature(
        signature: string,
        options: { signal?: AbortSignal } = {}
    ): Promise<Operation> {
        options.signal?.throwIfAborted();
        await this.signingCurrent();
        check(
            requiresAuthorization(this.#saved.plan),
            "operation does not require wallet authorization"
        );
        check(
            ["prepared", "authorized"].includes(this.status),
            "operation is not awaiting wallet authorization"
        );
        const authorization = await acceptWalletSignature(this.#saved.plan, signature);
        return this.stage(
            "wallet authorization",
            ["prepared", "authorized"],
            async () => ({ status: "authorized", authorization }),
            options.signal
        );
    }

    /** Export only after proving when the funding authorization binds an actual proof hash. */
    async exportFundingAuthorization(options: { signal?: AbortSignal } = {}) {
        options.signal?.throwIfAborted();
        await this.signingCurrent();
        check(
            this.status === (this.kind === "shield" ? "prepared" : "proved"),
            "operation is not awaiting funding authorization or proof"
        );
        const request = await fundingSigningRequest(this.#saved, this.#runtime);
        options.signal?.throwIfAborted();
        await this.signingCurrent();
        return request;
    }

    /** Verify an external signature against this handle's own frozen operation. */
    async withFundingSignature(
        signature: string,
        options: { signal?: AbortSignal } = {}
    ): Promise<Operation> {
        options.signal?.throwIfAborted();
        await this.signingCurrent();
        check(
            this.status === (this.kind === "shield" ? "prepared" : "proved"),
            "operation is not awaiting funding authorization or proof"
        );
        const verified = await acceptFundingSignature(this.#saved, signature, this.#runtime);
        return this.stage(
            "funding authorization",
            this.kind === "shield" ? ["prepared"] : ["proved"],
            async (saved) => {
                saved.plan.funding.signature = verified;
                if (saved.plan.statement?.target !== "noir-recursive") {
                    saved.call = await this.encode(saved);
                }
                return { status: "ready" };
            },
            options.signal
        );
    }

    async authorize(options: { signal?: AbortSignal } = {}): Promise<Operation> {
        check(
            requiresAuthorization(this.#saved.plan),
            "operation does not require wallet authorization"
        );
        const provider = this.#runtime.authorization();
        check(
            provider.ownerAddress === this.#runtime.scope.ownerAddress,
            "wallet authorization capability mismatch"
        );
        return this.stage(
            "wallet authorization",
            ["prepared", "authorized"],
            async (saved) => {
                const authorization = await authorizeOperation(saved.plan, provider);
                return { status: "authorized", authorization };
            },
            options.signal
        );
    }

    async prove(suppliedOptions: TransactionProveOptions = {}): Promise<Operation> {
        const options = { ...suppliedOptions };
        check(
            !this.#saved.broadcasterQuote || options.execution !== "aggregate",
            "a broadcaster quote requires direct execution"
        );
        const plan = this.#saved.plan;
        check(
            plan.kind !== "shield" && plan.kind !== "revoke-credit",
            "operation requires no proof"
        );
        if (requiresAuthorization(plan)) {
            check(
                this.#authorization,
                "local wallet authorization required; authorize again after recovery"
            );
        }
        const prover = this.#runtime.options.prover;
        if (!prover) {
            throw new MissingCapabilityError("prover");
        }
        return this.stage(
            "proof",
            requiresAuthorization(plan) ? ["authorized"] : ["prepared"],
            async (saved) => {
                const p = saved.plan;
                saved.proof = await proveOperation(
                    this.#runtime.options.protocol,
                    p,
                    this.#authorization,
                    prover,
                    options
                );
                if (p.fundingMode === "signature") {
                    return { status: "proved" };
                }
                if (p.statement?.target !== "noir-recursive") {
                    saved.call = await this.encode(saved);
                }
                return { status: "ready" };
            },
            options.signal
        );
    }

    private encode(saved: SavedOperation): Promise<TransactionCall> {
        return encodeOperation(saved);
    }

    async authorizeFunding(options: { signal?: AbortSignal } = {}): Promise<Operation> {
        const p = this.#saved.plan;
        check(p.fundingMode === "signature", "operation does not require a funding signature");
        check(p.kind === "shield" || this.#saved.proof, "proof must precede funding authorization");
        const signer = this.#runtime.options.fundingSigner;
        if (!signer) {
            throw new MissingCapabilityError("EVM funding signer");
        }
        check(
            signer.address.toLowerCase() === p.funding.payer!.toLowerCase(),
            "funding signer is not the payer"
        );
        return this.stage(
            "funding authorization",
            p.kind === "shield" ? ["prepared"] : ["proved"],
            async (saved) => {
                saved.plan.funding.signature = await signOperationFunding(
                    saved,
                    signer,
                    this.#runtime.options.fundingVerifier
                );
                if (saved.plan.statement?.target !== "noir-recursive") {
                    saved.call = await this.encode(saved);
                }
                return { status: "ready" };
            },
            options.signal
        );
    }

    /** Shield caller funding needs no wallet signing or proof; this step only encodes its frozen request. */
    async ready(): Promise<Operation> {
        check(
            (this.kind === "shield" && this.#saved.plan.fundingMode === "caller") ||
                this.kind === "revoke-credit",
            "operation needs authorization or proof first"
        );
        return this.stage("encoding", ["prepared"], async (saved) => {
            saved.call = await this.encode(saved);
            return { status: "ready" };
        });
    }

    private async validateExport(signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        const { reader, options: runtimeOptions } = this.#runtime;
        await runtimeOptions.protocol.validateDeployment(reader);
        const head = await reader.getBlock(await reader.getLatestBlockNumber());
        const plan = this.#saved.plan;
        check(!operationExpired(plan, head.timestamp), "operation has expired");
        if (plan.fundingMode === "signature") {
            check(head.timestamp <= (plan.funding.deadline ?? 0n), "funding authorization expired");
            check(
                (await reader.getFundingNonce(plan.context, plan.funding.payer!, head)) ===
                    plan.funding.sigNonce,
                "funding nonce changed; prepare again"
            );
        }
        for (const source of operationSources(plan)) {
            check(
                await reader.isKnownRoot(plan.context, source.treeId, source.merkleRoot, head),
                "source root is no longer accepted; prepare again"
            );
        }
        const nullifiers = inputFacts(plan).map((input) => input.nullifier);
        if (nullifiers.length) {
            const spent = await reader.isSpent(plan.context, nullifiers, head);
            check(
                spent.length === nullifiers.length && spent.every((value) => value === false),
                "input spent or invalid spent response"
            );
        }
        signal?.throwIfAborted();
    }

    async exportTransaction(options: { signal?: AbortSignal } = {}): Promise<TransactionCall> {
        check(
            this.#saved.plan.statement?.target !== "noir-recursive",
            "recursive operations must be exported as aggregate members"
        );
        await this.validateExport(options.signal);
        const result = await this.#runtime.store.transaction(this.#runtime.scope, (state) => {
            options.signal?.throwIfAborted();
            const record = state.operations[this.id];
            const saved = this.current(record);
            check(record!.status === "ready" && saved.call, "operation is not ready");
            saved.externalized = true;
            return structuredClone(saved.call);
        });
        return result;
    }

    async exportAggregateMember(): Promise<OperationAggregateMember> {
        return this.#runtime.store.transaction(this.#runtime.scope, (state) => {
            const record = state.operations[this.id];
            const saved = this.current(record);
            const plan = saved.plan;
            check(
                ["ready", "uncertain"].includes(record!.status) &&
                    plan.params &&
                    saved.proof &&
                    plan.statement?.target === "noir-recursive" &&
                    plan.statement.circuitName.startsWith("transact_user_slots") &&
                    (plan.capacity ?? 0) <= 10,
                "operation is not a ready recursive C1..C10 aggregate member"
            );
            sameStatement(saved.proof, statement(plan));
            check(
                saved.proof.proofHex.length === 2 + 458 * 64,
                "recursive member proof must have 458 fields"
            );
            saved.externalized = true;
            return {
                bundle: publicProof(saved.proof),
                statement: structuredClone(plan.statement),
                context: { ...plan.context },
                request: {
                    params: structuredClone(plan.params),
                    deliveries: plan.outputs.map((output) => structuredClone(output.delivery)),
                    funding: normalizeFunding(plan.funding),
                },
            };
        });
    }

    async abandon(): Promise<Operation> {
        const saved = await this.#runtime.store.transaction(this.#runtime.scope, (state) => {
            const record = state.operations[this.id];
            const current = this.current(record);
            check(
                !current.externalized,
                "externalized or broadcast operation requires chain reconciliation"
            );
            check(
                !["confirmed", "reorged"].includes(record!.status),
                "operation requires chain reconciliation"
            );
            for (const id of record!.inputs) {
                if (state.reservations[id] === this.id) {
                    delete state.reservations[id];
                }
            }
            record!.status = "failed";
            current.generation++;
            return structuredClone(current);
        });
        return new Operation(this.#runtime, saved, "failed");
    }

    /** Record an application-owned signed/broadcast transaction. This never sends or waits. */
    async trackTransaction(transactionHash: string): Promise<Operation> {
        check(/^0x[a-fA-F0-9]{64}$/.test(transactionHash), "invalid transaction hash");
        const saved = await this.#runtime.store.transaction(this.#runtime.scope, (state) => {
            check(!state.invalidated, "wallet requires canonical resync");
            const record = state.operations[this.id];
            const current = this.current(record);
            check(
                ["ready", "uncertain", "submitted"].includes(record!.status),
                "operation is not ready"
            );
            check(
                current.externalized,
                "export the transaction or aggregate member before tracking"
            );
            for (const input of record!.inputs) {
                check(state.reservations[input] === this.id, "operation input reservation lost");
            }
            current.generation++;
            current.externalized = true;
            record!.transactionHash = transactionHash as Hex;
            // A hash records an association, not proof that a transaction was broadcast or mined.
            record!.status = "uncertain";
            return structuredClone(current);
        });
        return new Operation(this.#runtime, saved, "uncertain");
    }

    async reconcile(
        options: { transactionHash?: Hex; signal?: AbortSignal } = {}
    ): Promise<Operation> {
        options.signal?.throwIfAborted();
        const state = await this.#runtime.store.readSnapshot(this.#runtime.scope);
        const record = state.operations[this.id];
        this.current(record);
        check(!state.invalidated, "wallet requires canonical resync");
        const hash = options.transactionHash ?? record!.transactionHash;
        let outcome: { status: OperationStatus; saved: SavedOperation } | undefined;
        if (hash) {
            outcome = await confirmOperation(
                this.#runtime,
                this.id,
                this.#saved.generation,
                hash,
                options.signal
            );
        }
        outcome ??= await reconcileOperation(
            this.#runtime,
            this.id,
            this.#saved.generation,
            options.signal
        );
        return new Operation(this.#runtime, outcome.saved, outcome.status);
    }

    toJSON() {
        return { id: this.id, kind: this.kind, status: this.status };
    }

    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
