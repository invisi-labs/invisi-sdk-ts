import { estimateGasReference } from "./gas-estimation";
import {
    authorizeOperation,
    proveOperation,
    signOperationFunding,
    walletSigningRequest,
    acceptWalletSignature,
    fundingSigningRequest,
    acceptFundingSignature,
} from "./session/operation-execution";
import {
    MissingCapabilityError,
    type AuthorizedStatement,
    type WalletAuthorizationProvider,
} from "@invisi-labs/core";
import { normalizeFunding, type TransactionCall } from "@invisi-labs/protocol";
import type { Prover, ProofBundle } from "@invisi-labs/prover";
import type {
    FundingSigner,
    OperationPlan,
    OperationRuntime,
    OperationAggregateMember,
    SavedOperation,
    TransactionProveOptions,
} from "./session/operation-types";
import type { OperationStatus } from "./session/state";
import {
    encodeOperation,
    publicProof,
    requiresAuthorization,
    statement,
} from "./session/operation-protocol";
import { sameStatement } from "./session/proof-integrity";
import { operationPreview } from "./session/operation-preview";
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}

type Runtime = Omit<OperationRuntime, "store">;
type Lifecycle = { generation: number; busy: boolean };
/** An immutable, local transaction handle. No wallet inventory, reservations or persistence. */
export class PreparedTransaction {
    readonly #runtime: Runtime;
    readonly #saved: SavedOperation;
    readonly #authorization: AuthorizedStatement | undefined;
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
    get id() {
        return this.#saved.plan.id;
    }
    get kind() {
        return this.#saved.plan.kind;
    }
    estimateGas() {
        return estimateGasReference(
            this.#saved.plan,
            this.#runtime.options.protocol,
            this.#runtime.options.gasBenchmarks
        );
    }
    preview() {
        return operationPreview(this.#saved.plan, this.status);
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

    async authorize(options?: { signal?: AbortSignal }): Promise<PreparedTransaction>;
    async authorize(
        provider: WalletAuthorizationProvider,
        options?: { signal?: AbortSignal }
    ): Promise<PreparedTransaction>;
    async authorize(
        providerOrOptions: WalletAuthorizationProvider | { signal?: AbortSignal } = {},
        suppliedOptions: { signal?: AbortSignal } = {}
    ): Promise<PreparedTransaction> {
        const options = "authorize" in providerOrOptions ? suppliedOptions : providerOrOptions;
        const provider =
            "authorize" in providerOrOptions ? providerOrOptions : this.#runtime.authorization();
        check(
            requiresAuthorization(this.#saved.plan),
            "operation does not require wallet authorization"
        );
        const selectedProvider = provider;
        check(
            provider.walletIdentity === this.#runtime.scope.walletIdentity,
            "wallet authorization capability mismatch"
        );
        return this.stage(
            "wallet authorization",
            ["prepared", "authorized"],
            async (saved) => {
                const authorization = await authorizeOperation(saved.plan, selectedProvider);
                return { status: "authorized", authorization };
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
        const plan = this.#saved.plan;
        check(plan.kind !== "shield", "shield requires no proof");
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

    async authorizeFunding(options?: { signal?: AbortSignal }): Promise<PreparedTransaction>;
    async authorizeFunding(
        signer: FundingSigner,
        options?: { signal?: AbortSignal }
    ): Promise<PreparedTransaction>;
    async authorizeFunding(
        signerOrOptions: FundingSigner | { signal?: AbortSignal } = {},
        suppliedOptions: { signal?: AbortSignal } = {}
    ): Promise<PreparedTransaction> {
        const options = "signTypedData" in signerOrOptions ? suppliedOptions : signerOrOptions;
        const suppliedSigner = "signTypedData" in signerOrOptions ? signerOrOptions : undefined;
        const p = this.#saved.plan;
        check(p.fundingMode === "signature", "operation does not require a funding signature");
        check(p.kind === "shield" || this.#saved.proof, "proof must precede funding authorization");
        const signer = suppliedSigner ?? this.#runtime.options.fundingSigner;
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
    async ready(): Promise<PreparedTransaction> {
        check(
            this.kind === "shield" && this.#saved.plan.fundingMode === "caller",
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
                plan.statement.circuitName === "transact_user_slots14",
            "ready recursive slots14 transaction required"
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
