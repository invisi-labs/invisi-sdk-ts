import {
    broadcasterSubmissionRefusal,
    assertBroadcasterNotRefused,
} from "../../broadcaster/submission-refusal";
import { readTransactionConfirmation, type TransactionConfirmation } from "@invisi-labs/protocol";
import { bindBroadcasterOperation } from "../../broadcaster/operation-bridge";
import {
    prepareWalletRequest,
    acceptWalletResponse,
    type PreparedWalletRequest,
    type WalletResponse,
} from "@invisi-labs/primitives";
import { revocationSigningRequest, acceptRevocationSignature } from "../signing/revocation";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { TransactionOutput } from "../../notes/TransactionOutput";
import { MissingCapabilityError, type AuthorizedStatement } from "@invisi-labs/primitives";
import { normalizeFunding, type TransactionCall } from "@invisi-labs/protocol";
import type { ProofBundle, Prover } from "@invisi-labs/prover";
import { exportBroadcasterIntent } from "../../broadcaster/intent";
import { resolveQuotedExecution } from "../../broadcaster/execution";
import {
    exportBroadcasterSubmission,
    publicOperationData,
    requiresProvenanceFinalization,
    retainedSidecarsHash,
} from "../../broadcaster/submission";
import { estimateOperationGas } from "../../gas/gas-estimation";
import type {
    OperationAggregateMember,
    OperationPlan,
    SavedOperation,
    TransactionProveOptions,
    TransactionRuntime,
} from "../operation-types";
import { publicProof } from "../proving/proof";
import { sameStatement } from "../proving/proof-integrity";
import type { OperationStatus } from "../records";
import {
    assertCreditPeriodCurrent,
    operationExpired,
    authorizationRequest,
    requiresAuthorization,
    statement,
} from "../signing/statement";
import { encodeOperation } from "./calldata";
import {
    acceptFundingSignature,
    acceptWalletSignature,
    fundingSigningRequest,
    proveOperation,
    walletSigningRequest,
} from "./operation-execution";
import { operationPreview } from "./operation-preview";
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}

type Runtime = TransactionRuntime;
type Lifecycle = {
    generation: number;
    busy: boolean;
    mainProver?: Prover;
    persistSchedule?: import("../../broadcaster/broadcaster-preparation").BroadcasterQuoteOptions["persistSchedule"];
};
/** An immutable, local transaction handle. No wallet inventory, reservations or persistence. */
export class PreparedTransaction {
    readonly #runtime: Runtime;
    readonly #saved: SavedOperation;
    readonly #authorization: AuthorizedStatement | undefined;
    readonly #walletRequests = new Map<string, PreparedWalletRequest<"wallet.authorize">>();
    readonly #lifecycle: Lifecycle;
    readonly status: OperationStatus;
    private constructor(
        runtime: Runtime,
        saved: SavedOperation,
        status: OperationStatus,
        lifecycle: Lifecycle,
        authorization?: AuthorizedStatement
    ) {
        this.#runtime = runtime;
        this.#saved = structuredClone(saved);
        this.#lifecycle = lifecycle;
        this.#authorization = authorization;
        this.status = status;
        bindBroadcasterOperation(this, {
            quote: (client, options) => this.#quoteForBroadcaster(client, options),
            submit: (client) => this.#submitViaBroadcaster(client),
            cancel: (client) => this.#cancelViaBroadcaster(client),
            provenanceContext: async () => {
                this.current();
                return {
                    chainId: this.#saved.plan.context.chainId,
                    protocolAddress: this.#saved.plan.context.protocolAddress,
                };
            },
            readProvenance: async () => {
                this.current();
                if (
                    this.#saved.provenance &&
                    this.#saved.provenance.data !== publicOperationData(this.#saved)
                )
                    throw Error("Prepared Provenance statement changed");
                return structuredClone(this.#saved.provenance);
            },
            proveProvenance: (capability, reprove) => this.#proveProvenance(capability, reprove),
        });
        Object.freeze(this);
    }
    static prepare(runtime: Runtime, plan: OperationPlan): PreparedTransaction {
        return new PreparedTransaction(
            runtime,
            { plan: structuredClone(plan), generation: 0 },
            "prepared",
            { generation: 0, busy: false }
        );
    }
    /** Observe canonical inclusion/finality only; this does not verify the intended operation effects. */
    async getConfirmation(transactionHash: Hex): Promise<TransactionConfirmation> {
        await this.#runtime.options.protocol.validateDeployment(this.#runtime.reader, {
            revocationFeeAmount:
                this.#saved.plan.kind === "revoke-credit"
                    ? this.#saved.plan.credit?.revocation?.feeAmount
                    : undefined,
        });
        return readTransactionConfirmation(this.#runtime.reader, transactionHash);
    }
    /** Persisted scoped cancellation record; available before submitting. */
    broadcasterScheduleHandle() {
        return structuredClone(this.#saved.broadcasterBinding?.scheduleHandle);
    }
    broadcasterQuote() {
        return this.#saved.broadcasterQuote
            ? structuredClone(this.#saved.broadcasterQuote)
            : undefined;
    }
    async #quoteForBroadcaster(
        client: import("../../broadcaster/index").BroadcasterClient,
        options: import("../../broadcaster/broadcaster-preparation").BroadcasterQuoteOptions
    ): Promise<PreparedTransaction> {
        this.current();
        check(
            this.status === "prepared",
            "broadcaster must attach to an unsigned prepared transaction"
        );
        const { prepareBroadcasterPlan } =
            await import("../../broadcaster/broadcaster-preparation");
        const selected = await prepareBroadcasterPlan(this.#saved.plan, client, options);
        this.current();
        return new PreparedTransaction(
            this.#runtime,
            {
                plan: selected.plan,
                broadcasterQuote: selected.quote,
                broadcasterBinding: selected.broadcasterBinding,
                generation: 0,
            },
            "prepared",
            {
                generation: 0,
                busy: false,
                ...(options.persistSchedule ? { persistSchedule: options.persistSchedule } : {}),
            }
        );
    }
    async #proveProvenance(
        capability?: import("../../broadcaster/provenance-preparation").PreparedProvenanceCapability,
        reprove = false
    ) {
        this.current();
        check(this.status === "ready", "Ready transaction required for Provenance");
        const { provePreparedProvenance } =
            await import("../../broadcaster/provenance-preparation");
        this.#lifecycle.busy = true;
        try {
            const packet = await provePreparedProvenance(
                this.#saved,
                this.#runtime,
                capability,
                reprove
            );
            if (!this.#saved.broadcasterAttempted && !this.#saved.broadcasterRequest) {
                this.#saved.provenance = structuredClone(packet);
                if (capability)
                    this.#saved.provenanceTrust = structuredClone(capability.client.trust);
            }
            return packet;
        } finally {
            this.#lifecycle.busy = false;
        }
    }
    async #submitViaBroadcaster(client: import("../../broadcaster/index").BroadcasterClient) {
        this.current();
        check(!this.#saved.broadcasterCancelled, "Broadcaster cancellation already acknowledged");
        check(this.status === "ready", "transaction is not ready");
        assertBroadcasterNotRefused(this.#saved.broadcasterRefusal);
        const { validateBroadcastEnvelope, validatePreparedBroadcast, validateRetainedProvenance } =
            await import("../../broadcaster/provenance-preparation");
        validateBroadcastEnvelope(this.#saved, client);
        if (this.#saved.broadcasterSubmissionId) {
            return client.status(this.#saved.broadcasterSubmissionId);
        }
        const sidecarsHash = retainedSidecarsHash(this.#saved);
        if (
            this.#saved.broadcasterAttempted &&
            sidecarsHash &&
            !this.#saved.broadcasterSidecarsHash
        )
            await validateRetainedProvenance(this.#saved);
        if (
            this.#saved.broadcasterSidecarsHash &&
            this.#saved.broadcasterSidecarsHash !== sidecarsHash
        )
            throw Error("Frozen broadcaster Source sidecars changed");
        const schedule = this.#saved.broadcasterBinding?.scheduleHandle;
        const authority =
            schedule && !this.#saved.broadcasterAttempted
                ? (
                      await import("../../broadcaster/submission-authority")
                  ).captureSubmissionAuthority(
                      this.#runtime,
                      this.#saved.plan.context.chainId,
                      client
                  )
                : undefined;
        // A lost first response has no ID yet. Resend the retained request; only the relay can deduplicate it.
        if (!this.#saved.broadcasterAttempted) {
            const credit = this.#saved.plan.credit;
            if (credit?.draw || credit?.creation?.hasInitialPayment) {
                await this.validateSubmission();
            }
            await client.submissionRequirements(this.#saved.broadcasterQuote!);
            await validatePreparedBroadcast(this.#saved, client, this.#runtime);
        }
        assertBroadcasterNotRefused(this.#saved.broadcasterRefusal);
        const first =
            !this.#saved.broadcasterAttempted &&
            !this.#saved.externalized &&
            !this.#saved.broadcasterSubmissionId;
        if (sidecarsHash !== retainedSidecarsHash(this.#saved))
            throw Error("Prepared Provenance changed during submission");
        if (sidecarsHash) this.#saved.broadcasterSidecarsHash ??= sidecarsHash;
        this.#saved.externalized = true;
        this.#saved.broadcasterRequest ??= exportBroadcasterSubmission(this.#saved);
        const handle = this.#saved.broadcasterBinding?.scheduleHandle;
        if (handle && !handle.submission) {
            const pending = {
                ...handle,
                submission: {
                    ...structuredClone(this.#saved.broadcasterRequest),
                    proofSidecars: structuredClone(this.#saved.provenance?.sidecars ?? []),
                },
            };
            await this.#lifecycle.persistSchedule!(structuredClone(pending));
            this.#saved.broadcasterBinding!.scheduleHandle = pending;
        }
        const credit = this.#saved.plan.credit;
        const checkCreditPeriod =
            !this.#saved.broadcasterAttempted &&
            (credit?.draw || credit?.creation?.hasInitialPayment);
        if (!authority && checkCreditPeriod) await this.validateSubmission();
        this.#saved.broadcasterAttempted = true;
        const attemptToken = crypto.randomUUID();
        this.#saved.broadcasterAttemptToken = attemptToken;
        const request = this.#saved.broadcasterRequest;
        if (authority) {
            // The scheduled packet is already durable. Any failure from here
            // retains this exact attempt for explicit ID-less replay.
            if (this.#saved.provenance?.sidecars.length) await client.prepareSubmissionEncoding();
            if (checkCreditPeriod) await this.validateSubmission();
            await authority.validate();
            this.current();
            check(
                !this.#saved.broadcasterCancelled &&
                    !this.#saved.broadcasterSubmissionId &&
                    this.#saved.broadcasterAttemptToken === attemptToken,
                "scheduled submission changed or cancelled"
            );
            authority.assertCurrent();
        }
        let result;
        try {
            result = await client.submitTransaction(
                request.data,
                this.#saved.broadcasterQuote!,
                structuredClone(this.#saved.provenance?.sidecars ?? []),
                structuredClone(request.memberProof)
            );
        } catch (cause) {
            const refusal = broadcasterSubmissionRefusal(cause);
            if (
                refusal &&
                first &&
                !this.#saved.broadcasterSubmissionId &&
                this.#saved.broadcasterAttemptToken === attemptToken
            ) {
                this.#saved.broadcasterAttempted = false;
                this.#saved.externalized = false;
                this.#saved.broadcasterRefusal = refusal.code;
            }
            throw refusal ?? cause;
        }
        check(
            !this.#saved.broadcasterSubmissionId ||
                this.#saved.broadcasterSubmissionId === result.id,
            "broadcaster changed submission ID"
        );
        const scheduled = this.#saved.broadcasterBinding?.scheduleHandle;
        if (scheduled) {
            const acknowledged = { ...scheduled, id: result.id };
            await this.#lifecycle.persistSchedule!(structuredClone(acknowledged));
            this.#saved.broadcasterBinding!.scheduleHandle = acknowledged;
        }
        this.#saved.broadcasterSubmissionId = result.id;
        return result;
    }
    async #cancelViaBroadcaster(
        client: import("../../broadcaster/index").BroadcasterClient
    ): Promise<import("../../broadcaster").BroadcasterStatus> {
        this.current();
        const binding = this.#saved.broadcasterBinding;
        const handle = binding?.scheduleHandle;
        check(handle, "Transaction has no scheduled cancellation capability");
        check(
            JSON.stringify(binding!.configuration) === JSON.stringify(client.configuration),
            "Broadcaster differs from the scheduled registration"
        );
        if (!handle.id) {
            check(this.#saved.broadcasterAttempted, "Scheduled transaction has not been submitted");
            throw Error(
                "Missing broadcaster ID; recover the original frozen submission before cancellation"
            );
        }
        if (this.#saved.broadcasterCancelled)
            return structuredClone(
                this.#saved.broadcasterCancellation ?? { id: handle.id, state: "cancelled" }
            );
        const status = await client.cancelScheduled(handle, {
            chainId: this.#saved.plan.context.chainId,
            protocol: this.#saved.plan.context.protocolAddress,
        });
        check(
            status.state === "cancelled" && !status.transactionHash,
            "Broadcaster cancellation not confirmed"
        );
        this.#saved.broadcasterCancelled = true;
        this.#saved.broadcasterCancellation = structuredClone(status);
        return status;
    }
    get id() {
        return this.#saved.plan.id;
    }
    get kind() {
        return this.#saved.plan.kind;
    }
    estimateGas() {
        return estimateOperationGas(
            this.#saved.plan,
            this.#saved.broadcasterQuote?.quote.execution
        );
    }
    /** Final Note outputs, including change; Credit outputs are not exported as IPN. */
    getOutputs(): readonly TransactionOutput[] {
        return Object.freeze(
            this.#saved.plan.outputs.map((output) => new TransactionOutput(output))
        );
    }
    preview() {
        return operationPreview(this.#saved.plan, this.status);
    }
    /** Obtain a firm quote before signing. This intent contains no private inputs or witness. */
    async exportBroadcasterIntent() {
        this.current();
        check(
            ["prepared", "authorized"].includes(this.status),
            "quote intent requires a prepared transaction"
        );
        return exportBroadcasterIntent(this.#saved.plan);
    }
    private current() {
        check(
            !this.#lifecycle.busy && this.#lifecycle.generation === this.#saved.generation,
            "stale transaction handle or active worker"
        );
    }
    private async stage(
        stage: string,
        allowed: OperationStatus[],
        work: (
            saved: SavedOperation
        ) => Promise<{ status: OperationStatus; authorization?: AuthorizedStatement }>,
        signal?: AbortSignal
    ): Promise<PreparedTransaction> {
        signal?.throwIfAborted();
        this.current();
        check(allowed.includes(this.status), `invalid transaction stage for ${stage}`);
        this.#lifecycle.busy = true;
        const saved = structuredClone(this.#saved);
        try {
            const next = await work(saved);
            signal?.throwIfAborted();
            saved.generation++;
            this.#lifecycle.generation = saved.generation;
            return new PreparedTransaction(
                this.#runtime,
                saved,
                next.status,
                this.#lifecycle,
                next.authorization ?? this.#authorization
            );
        } finally {
            this.#lifecycle.busy = false;
        }
    }
    async exportRevocationAuthorization() {
        this.current();
        check(this.status === "prepared", "revocation is not awaiting authorization");
        return revocationSigningRequest(this.#saved.plan, this.#runtime);
    }
    async withRevocationSignature(signature: Hex): Promise<PreparedTransaction> {
        this.current();
        const verified = await acceptRevocationSignature(
            this.#saved.plan,
            signature,
            this.#runtime
        );
        return this.stage("revocation authorization", ["prepared"], async (saved) => {
            saved.plan.credit!.revocationSignature = verified;
            saved.call = await this.encode(saved);
            return { status: "ready" };
        });
    }
    /** Export the same portable request used by managed native wallet transports. */
    async exportWalletRequest(id: string, options: { signal?: AbortSignal } = {}) {
        options.signal?.throwIfAborted();
        this.current();
        check(
            requiresAuthorization(this.#saved.plan),
            "operation does not require wallet authorization"
        );
        check(
            ["prepared", "authorized"].includes(this.status),
            "operation is not awaiting wallet authorization"
        );
        check(!this.#walletRequests.has(id), "wallet request id already exported");
        const request = authorizationRequest(this.#saved.plan);
        const prepared = prepareWalletRequest(
            this.#saved.plan.scope.ownerAddress,
            id,
            "wallet.authorize",
            {
                ...request,
                words: request.words.map(String),
                context: {
                    chainId: request.context.chainId.toString(),
                    protocolAddress: request.context.protocolAddress.toString(),
                },
            }
        );
        this.#walletRequests.set(id, prepared);
        return structuredClone(prepared.request);
    }

    /** Independently validate host authorization against the retained request and frozen plan. */
    async withWalletResponse(
        response: WalletResponse,
        options: { signal?: AbortSignal } = {}
    ): Promise<PreparedTransaction> {
        options.signal?.throwIfAborted();
        this.current();
        check(
            requiresAuthorization(this.#saved.plan),
            "operation does not require wallet authorization"
        );
        const prepared = this.#walletRequests.get(response.id);
        check(prepared, "unknown wallet request response");
        const authorization = await acceptWalletResponse(
            prepared,
            response as WalletResponse<"wallet.authorize">
        );
        return this.stage(
            "wallet authorization",
            ["prepared", "authorized"],
            async () => ({ status: "authorized", authorization }),
            options.signal
        );
    }

    /** Public EIP-712 request; signing transport and key custody belong to the caller. */
    async exportWalletAuthorization(options: { signal?: AbortSignal } = {}) {
        options.signal?.throwIfAborted();
        this.current();
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
    ): Promise<PreparedTransaction> {
        options.signal?.throwIfAborted();
        this.current();
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
        this.current();
        check(
            this.status === (this.kind === "shield" ? "prepared" : "proved") &&
                (!this.#saved.plan.funding.signature ||
                    this.#saved.plan.funding.signature === "0x"),
            "operation is not awaiting funding authorization or proof"
        );
        const request = await fundingSigningRequest(this.#saved, this.#runtime);
        options.signal?.throwIfAborted();
        this.current();
        return request;
    }

    /** Verify an external signature against this handle's own frozen operation. */
    async withFundingSignature(
        signature: string,
        options: { signal?: AbortSignal } = {}
    ): Promise<PreparedTransaction> {
        options.signal?.throwIfAborted();
        this.current();
        check(
            this.status === (this.kind === "shield" ? "prepared" : "proved") &&
                (!this.#saved.plan.funding.signature ||
                    this.#saved.plan.funding.signature === "0x"),
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
                return { status: requiresProvenanceFinalization(saved) ? "proved" : "ready" };
            },
            options.signal
        );
    }

    async prove(options?: TransactionProveOptions): Promise<PreparedTransaction>;
    async prove(backend: Prover, options?: TransactionProveOptions): Promise<PreparedTransaction>;
    async prove(
        backendOrOptions: Prover | TransactionProveOptions = {},
        suppliedOptions: TransactionProveOptions = {}
    ): Promise<PreparedTransaction> {
        const options = resolveQuotedExecution(
            this.#saved.broadcasterQuote,
            "prove" in backendOrOptions ? suppliedOptions : backendOrOptions
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
        const prover =
            "prove" in backendOrOptions ? backendOrOptions : this.#runtime.options.prover;
        if (!prover) {
            throw new MissingCapabilityError("prover");
        }
        const result = await this.stage(
            "proof",
            requiresAuthorization(plan) ? ["authorized"] : ["prepared"],
            async (saved) => {
                const p = saved.plan;
                saved.proof = await proveOperation(p, this.#authorization, prover, options);
                if (p.fundingMode === "signature" || requiresProvenanceFinalization(saved)) {
                    return { status: "proved" };
                }
                if (p.statement?.target !== "noir-recursive") {
                    saved.call = await this.encode(saved);
                }
                return { status: "ready" };
            },
            options.signal
        );
        if (requiresProvenanceFinalization(this.#saved)) this.#lifecycle.mainProver = prover;
        return result;
    }

    private encode(saved: SavedOperation): Promise<TransactionCall> {
        return encodeOperation(saved);
    }

    /** Finalize required Source evidence after main proof and funding authorization. */
    async ready(options: { signal?: AbortSignal } = {}): Promise<PreparedTransaction> {
        options.signal?.throwIfAborted();
        this.current();
        const required = requiresProvenanceFinalization(this.#saved);
        if (this.status === "ready" && (!required || this.#saved.provenance)) {
            if (required) {
                const { validateReadyProvenance } =
                    await import("../../broadcaster/provenance-preparation");
                await validateReadyProvenance(this.#saved, this.#runtime);
            }
            return this;
        }
        if (required) {
            return this.stage(
                "Source finalization",
                ["proved", "ready"],
                async (saved) => {
                    const { finalizePreparedProvenance } =
                        await import("../../broadcaster/provenance-preparation");
                    await finalizePreparedProvenance(
                        saved,
                        this.#lifecycle.mainProver
                            ? {
                                  ...this.#runtime,
                                  options: {
                                      ...this.#runtime.options,
                                      prover: this.#lifecycle.mainProver,
                                  },
                              }
                            : this.#runtime
                    );
                    return { status: "ready" };
                },
                options.signal
            );
        }
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

    /** Validate fresh chain time immediately before submitting an exported call. */
    async validateSubmission(): Promise<void> {
        this.current();
        check(this.status === "ready", "transaction is not ready");
        const head = await this.#runtime.reader.getBlock(
            await this.#runtime.reader.getLatestBlockNumber()
        );
        check(head.timestamp <= this.#saved.plan.deadline, "operation has expired");
        assertCreditPeriodCurrent(this.#saved.plan, head.timestamp);
        check(!operationExpired(this.#saved.plan, head.timestamp), "operation has expired");
    }

    async exportTransaction(): Promise<TransactionCall> {
        this.current();
        check(
            this.#saved.plan.statement?.target !== "noir-recursive",
            "recursive operations must be exported as aggregate members"
        );
        check(this.status === "ready" && this.#saved.call, "transaction is not ready");
        assertBroadcasterNotRefused(this.#saved.broadcasterRefusal);
        return structuredClone(this.#saved.call);
    }
    exportProof(): ProofBundle {
        this.current();
        check(this.#saved.proof, "transaction has no proof");
        return publicProof(this.#saved.proof);
    }
    exportAggregateMember(): OperationAggregateMember {
        this.current();
        const saved = this.#saved,
            plan = saved.plan;
        check(
            this.status === "ready" &&
                plan.params &&
                saved.proof &&
                plan.statement?.target === "noir-recursive" &&
                plan.statement.circuitName.startsWith("transact_user_slots") &&
                (plan.capacity ?? 0) <= 10,
            "ready recursive C1..C10 transaction required"
        );
        sameStatement(saved.proof, statement(plan));
        check(
            saved.proof.proofHex.length === 2 + 458 * 64,
            "recursive member proof must have 458 fields"
        );
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
    }
    toJSON() {
        return { transaction: true, id: this.id, kind: this.kind, status: this.status };
    }
    [Symbol.for("nodejs.util.inspect.custom")]() {
        return this.toJSON();
    }
}
