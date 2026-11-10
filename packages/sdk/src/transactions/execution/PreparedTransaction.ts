import { bindBroadcasterOperation } from "../../broadcaster/operation-bridge";
import {
    Wallet,
    prepareWalletRequest,
    acceptWalletResponse,
    type PreparedWalletRequest,
    type WalletResponse,
} from "@invisi-labs/core";
import { revocationSigningRequest, acceptRevocationSignature } from "../signing/revocation";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { TransactionOutput } from "../../notes/TransactionOutput";
import { MissingCapabilityError, type AuthorizedStatement } from "@invisi-labs/core";
import { normalizeFunding, type TransactionCall } from "@invisi-labs/protocol";
import type { ProofBundle, Prover } from "@invisi-labs/prover";
import { exportBroadcasterIntent } from "../../broadcaster/intent";
import { getOperationGasReference } from "../../gas/gas-estimation";
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
import { authorizationRequest, requiresAuthorization, statement } from "../signing/statement";
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

type Runtime = TransactionRuntime & {
    reprepare?: (
        intent: import("../../broadcaster/broadcaster-preparation").PreparationIntent
    ) => Promise<OperationPlan>;
};
type Lifecycle = { generation: number; busy: boolean };
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
            provenanceContext: async () => {
                this.current();
                return {
                    chainId: this.#saved.plan.context.chainId,
                    protocolAddress: this.#saved.plan.context.protocolAddress,
                };
            },
            readProvenance: async () => {
                this.current();
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
            this.status === "prepared" && this.#runtime.reprepare,
            "broadcaster must attach to an unsigned prepared transaction"
        );
        const { prepareBroadcasterPlan } =
            await import("../../broadcaster/broadcaster-preparation");
        const selected = await prepareBroadcasterPlan(
            this.#saved.plan,
            this.#runtime.reprepare,
            client,
            options
        );
        return new PreparedTransaction(
            this.#runtime,
            {
                plan: selected.plan,
                broadcasterQuote: selected.quote,
                broadcasterBinding: selected.broadcasterBinding,
                generation: 0,
            },
            "prepared",
            { generation: 0, busy: false }
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
            if (!this.#saved.broadcasterAttempted) this.#saved.provenance = structuredClone(packet);
            return packet;
        } finally {
            this.#lifecycle.busy = false;
        }
    }
    async #submitViaBroadcaster(client: import("../../broadcaster/index").BroadcasterClient) {
        this.current();
        check(this.status === "ready", "transaction is not ready");
        const { validateBroadcastEnvelope, validatePreparedBroadcast } =
            await import("../../broadcaster/provenance-preparation");
        validateBroadcastEnvelope(this.#saved, client);
        if (this.#saved.broadcasterSubmissionId) {
            try {
                return await client.status(this.#saved.broadcasterSubmissionId);
            } catch (error) {
                const { BroadcasterRpcError } = await import("../../broadcaster/index");
                if (!(error instanceof BroadcasterRpcError) || error.code !== -32001) throw error;
            }
        }
        // A lost first response has no ID yet. Resend the retained request; only the relay can deduplicate it.
        if (!this.#saved.broadcasterAttempted) {
            const requirements = await client.submissionRequirements(this.#saved.broadcasterQuote!);
            if (
                requirements.provenanceRequired &&
                this.#saved.plan.inputs.length &&
                !this.#saved.provenance
            )
                await this.#proveProvenance();
            await validatePreparedBroadcast(this.#saved, client, this.#runtime);
        }
        this.#saved.externalized = true;
        this.#saved.broadcasterAttempted = true;
        const result = await client.submitTransaction(
            this.#saved.call!.data,
            this.#saved.broadcasterQuote!,
            structuredClone(this.#saved.provenance?.sidecars ?? [])
        );
        check(
            !this.#saved.broadcasterSubmissionId ||
                this.#saved.broadcasterSubmissionId === result.id,
            "broadcaster changed submission ID"
        );
        this.#saved.broadcasterSubmissionId = result.id;
        return result;
    }
    get id() {
        return this.#saved.plan.id;
    }
    get kind() {
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
            Wallet.fromAddress(this.#saved.plan.scope.ownerAddress),
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
            this.status === (this.kind === "shield" ? "prepared" : "proved"),
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

    async prove(options?: TransactionProveOptions): Promise<PreparedTransaction>;
    async prove(backend: Prover, options?: TransactionProveOptions): Promise<PreparedTransaction>;
    async prove(
        backendOrOptions: Prover | TransactionProveOptions = {},
        suppliedOptions: TransactionProveOptions = {}
    ): Promise<PreparedTransaction> {
        const options = { ...("prove" in backendOrOptions ? suppliedOptions : backendOrOptions) };
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
        const prover =
            "prove" in backendOrOptions ? backendOrOptions : this.#runtime.options.prover;
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

    /** Shield caller funding needs no wallet signing or proof; this step only encodes its frozen request. */
    async ready(): Promise<PreparedTransaction> {
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

    async exportTransaction(): Promise<TransactionCall> {
        this.current();
        check(
            this.#saved.plan.statement?.target !== "noir-recursive",
            "recursive operations must be exported as aggregate members"
        );
        check(this.status === "ready" && this.#saved.call, "transaction is not ready");
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
