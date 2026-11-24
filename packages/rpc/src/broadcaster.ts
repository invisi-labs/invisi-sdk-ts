import { verifyBroadcasterFeeLock, type SignedBroadcasterFeeLock } from "./fee-lock";
export {
    verifyBroadcasterFeeLock,
    broadcasterFeeLockTypes,
    broadcasterFeeLockModel,
} from "./fee-lock";
export type { BroadcasterFeeLock, SignedBroadcasterFeeLock } from "./fee-lock";
import { provenanceIntentHash } from "@invisi-labs/primitives";
import type { ProofSidecar } from "@invisi-labs/protocol/provenance";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import { AbiCoder, getAddress, Interface, keccak256, verifyTypedData } from "ethers";

export const broadcasterQuoteTypes = {
    Quote: [
        { name: "token", type: "address" },
        { name: "feeRecipient", type: "address" },
        { name: "feeAmount", type: "uint256" },
        { name: "deadline", type: "uint256" },
        { name: "maxGas", type: "uint256" },
        { name: "requestHash", type: "bytes32" },
        { name: "execution", type: "string" },
    ],
};
export interface BroadcasterSchedule {
    publishAfter: string;
    executeBefore: string;
    cancelTokenHash: string;
}
export const scheduledBroadcasterQuoteTypes = {
    ScheduledQuote: [
        ...broadcasterQuoteTypes.Quote,
        { name: "publishAfter", type: "uint256" },
        { name: "executeBefore", type: "uint256" },
        { name: "cancelTokenHash", type: "bytes32" },
    ],
};
function canonicalScheduleSeconds(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length <= 16 &&
        /^[1-9][0-9]*$/.test(value) &&
        BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)
    );
}
function checkedSchedule(schedule: BroadcasterSchedule): BroadcasterSchedule {
    if (
        !schedule ||
        Object.keys(schedule).length !== 3 ||
        !canonicalScheduleSeconds(schedule.publishAfter) ||
        !canonicalScheduleSeconds(schedule.executeBefore) ||
        BigInt(schedule.publishAfter) >= BigInt(schedule.executeBefore) ||
        typeof schedule.cancelTokenHash !== "string" ||
        !/^0x[0-9a-f]{64}$/.test(schedule.cancelTokenHash) ||
        BigInt(schedule.cancelTokenHash) === 0n
    )
        throw Error("invalid broadcaster schedule");
    return { ...schedule };
}
export interface BroadcasterSchedulingCapabilities {
    enabled: boolean;
    maxDelaySeconds: string;
    defaultExecutionWindowSeconds: string;
    maxExecutionWindowSeconds: string;
    minDeadlineSlackSeconds: string;
}
export interface BroadcasterQuote {
    schedule?: BroadcasterSchedule;
    token: string;
    feeRecipient: string;
    feeAmount: string;
    deadline: string;
    maxGas: string;
    requestHash: string;
    execution: "direct" | "aggregate";
}
export interface BroadcasterEstimate {
    feeRecipient: string;
    feeAmount: string;
    maxGas: string;
}
export interface SignedBroadcasterQuote {
    quote: BroadcasterQuote;
    signature: string;
    provenanceRequired?: boolean;
    requestHashFormat?: string;
    context?: { chainId: bigint; protocol: string };
}
export interface BroadcasterTrust {
    chainId: bigint;
    protocol: string;
    signer: string;
}
export function broadcasterQuoteDomain(trust: BroadcasterTrust) {
    return {
        name: "InvisiBroadcaster",
        version: "1",
        chainId: trust.chainId,
        verifyingContract: getAddress(trust.protocol),
    };
}
const supportedMethods = [
    "transact",
    "shield",
    "createCredit",
    "creditDraw",
    "updateCredit",
    "revokeCredit",
];
const intentAbi = invisiCoreAbi.filter(
    (item) =>
        item.type === "function" &&
        supportedMethods.includes(item.name) &&
        (item.name !== "transact" || item.inputs[1]?.type === "tuple")
);
export const broadcasterTransactInterface = new Interface(intentAbi);
/** Decode a canonical supported direct public intent. Registry and aggregates are excluded. */
export function decodeBroadcasterIntent(data: string) {
    const parsed = broadcasterTransactInterface.parseTransaction({ data });
    if (!parsed || !supportedMethods.includes(parsed.name))
        throw new Error("unsupported broadcaster method");
    const fragment = parsed.fragment;
    const decoded = parsed.args;
    if (
        broadcasterTransactInterface.encodeFunctionData(fragment, decoded).toLowerCase() !==
        data.toLowerCase()
    )
        throw new Error("noncanonical broadcaster calldata");
    const method = parsed.name;
    const raw = method === "transact" ? decoded[1] : undefined;
    const credit = !["transact", "shield"].includes(method);
    const params =
        raw?.params ??
        (method === "shield"
            ? decoded[0]
            : method === "revokeCredit"
              ? {
                    token: decoded[0],
                    owner: decoded[1],
                    grantId: decoded[2],
                    deadline: decoded[3],
                    feeRecipient: decoded[4],
                    feeAmount: decoded[5],
                }
              : decoded[1]);
    const funding = raw?.funding ?? (method === "shield" ? decoded[3] : undefined);
    const deliveries =
        raw?.deliveries ??
        (method === "shield" ? decoded[2] : credit && method !== "revokeCredit" ? decoded[2] : []);
    return {
        fragment,
        method,
        args: decoded,
        credit,
        proof: method === "shield" || method === "revokeCredit" ? "0x" : (decoded[0] as string),
        request: { params, funding, deliveries },
    };
}
/** Domain-separated final public intent: omit proof bytes, funding.signature and revocation authorization. */
export function broadcasterRequestHash(data: string): string {
    const { fragment, method, args } = decodeBroadcasterIntent(data);
    const copy = (value: unknown): unknown => (Array.isArray(value) ? value.map(copy) : value);
    const canonical = copy(args) as unknown[];
    if (method !== "shield" && method !== "revokeCredit") canonical[0] = "0x";
    if (method === "revokeCredit") canonical[6] = "0x";
    if (method === "transact") ((canonical[1] as unknown[])[2] as unknown[])[4] = "0x";
    else if (method === "shield") (canonical[3] as unknown[])[4] = "0x";
    const calldata = broadcasterTransactInterface.encodeFunctionData(fragment, canonical);
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["string", "string", "bytes"],
            ["InvisiBroadcasterIntentV1", method, calldata]
        )
    );
}
export function verifyBroadcasterQuote(
    signed: SignedBroadcasterQuote,
    trust: BroadcasterTrust,
    data: string,
    now = BigInt(Math.floor(Date.now() / 1000))
) {
    const { quote } = signed;
    if (
        Object.keys(signed).some(
            (k) =>
                ![
                    "quote",
                    "signature",
                    "context",
                    "provenanceRequired",
                    "requestHashFormat",
                ].includes(k)
        )
    )
        throw Error("Unknown broadcaster quote field");
    if (quote?.execution !== "direct" && quote?.execution !== "aggregate")
        throw new Error("invalid broadcaster quote execution");
    const quoteFields = broadcasterQuoteTypes.Quote.map(({ name }) => name);
    if (quote.schedule !== undefined) {
        checkedSchedule(quote.schedule);
        quoteFields.push("schedule");
    }
    if (
        typeof quote !== "object" ||
        Array.isArray(quote) ||
        Object.keys(quote).length !== quoteFields.length ||
        Object.keys(quote).some((key) => !quoteFields.includes(key))
    )
        throw Error("Unknown or missing broadcaster quote field");
    if (quote.execution === "aggregate") aggregateMemberCapacity(data);
    const required = signed.provenanceRequired === true;
    if (
        required
            ? signed.provenanceRequired !== true ||
              signed.requestHashFormat !== "invisi-broadcaster-provenance-intent-v1"
            : signed.provenanceRequired !== undefined || signed.requestHashFormat !== undefined
    )
        throw new Error("broadcaster provenance requirement mismatch");
    const originalHash = broadcasterRequestHash(data);
    const expectedHash = required ? provenanceIntentHash(originalHash) : originalHash;
    const { request } = decodeBroadcasterIntent(data);
    const p = request.params;
    if (
        quote.requestHash !== expectedHash ||
        getAddress(quote.token) !== getAddress(p.token) ||
        getAddress(quote.feeRecipient) !== getAddress(p.feeRecipient) ||
        BigInt(quote.feeAmount) !== p.feeAmount ||
        BigInt(quote.deadline) > p.deadline ||
        BigInt(quote.deadline) < now ||
        BigInt(quote.maxGas) <= 0n ||
        BigInt(quote.feeAmount) <= 0n ||
        BigInt(quote.feeAmount) >= 1n << 128n
    )
        throw new Error("quote does not match final intent or bounds");
    if (
        getAddress(
            verifyTypedData(
                broadcasterQuoteDomain(trust),
                quote.schedule ? scheduledBroadcasterQuoteTypes : broadcasterQuoteTypes,
                quote.schedule ? { ...quote, ...quote.schedule } : quote,
                signed.signature
            )
        ) !== getAddress(trust.signer)
    )
        throw new Error("untrusted quote signature");
    return quote;
}
/** Public proof bundle wire shape; RPC does not depend on a prover implementation. */
export interface BroadcasterMemberProof {
    formatVersion: 1;
    circuitName: string;
    target: "evm" | "noir-recursive";
    bbVersion: "6.0.0";
    artifactSha256: string;
    vkSha256: string;
    proofHex: `0x${string}`;
    proofSha256: string;
    publicInputs: readonly `0x${string}`[];
}
function aggregateMemberCapacity(data: string): number {
    const { method, request } = decodeBroadcasterIntent(data);
    const capacity = request.params.nullifiers?.length + request.params.noteCommitments?.length;
    if (
        method !== "transact" ||
        request.params.nullifiers.length === 0 ||
        !Number.isInteger(capacity) ||
        capacity < 1 ||
        capacity > 10 ||
        request.funding.amount !== 0n
    )
        throw Error("unfunded private C1 through C10 member required");
    return capacity;
}
function checkedMemberProof(data: string, proof: BroadcasterMemberProof): BroadcasterMemberProof {
    const capacity = aggregateMemberCapacity(data);
    const fields = [
        "formatVersion",
        "circuitName",
        "target",
        "bbVersion",
        "artifactSha256",
        "vkSha256",
        "proofHex",
        "proofSha256",
        "publicInputs",
    ];
    if (
        !proof ||
        typeof proof !== "object" ||
        Array.isArray(proof) ||
        Object.keys(proof).length !== fields.length ||
        Object.keys(proof).some((k) => !fields.includes(k)) ||
        proof.formatVersion !== 1 ||
        proof.target !== "noir-recursive" ||
        proof.bbVersion !== "6.0.0" ||
        proof.circuitName !== `transact_user_slots${capacity}` ||
        ![proof.artifactSha256, proof.vkSha256, proof.proofSha256].every(
            (v) => typeof v === "string" && /^[0-9a-f]{64}$/.test(v)
        ) ||
        typeof proof.proofHex !== "string" ||
        !/^0x(?:[0-9a-fA-F]{2})+$/.test(proof.proofHex) ||
        proof.proofHex.toLowerCase() !== decodeBroadcasterIntent(data).proof.toLowerCase() ||
        !Array.isArray(proof.publicInputs) ||
        proof.publicInputs.length !== 17 + 3 * capacity ||
        !proof.publicInputs.every((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v))
    )
        throw Error("invalid broadcaster member proof");
    const params = decodeBroadcasterIntent(data).request.params;
    if (
        BigInt(proof.publicInputs[3]!) !== BigInt(params.nullifiers.length) ||
        BigInt(proof.publicInputs[4]!) !== BigInt(params.noteCommitments.length)
    )
        throw Error("member proof public shape mismatch");
    return { ...proof, publicInputs: [...proof.publicInputs] };
}
export interface BroadcasterConfirmation {
    level: "pending" | "included" | "safe" | "finalized";
    status: import("@invisi-labs/protocol").FinalityStatus;
    block: { number: string; hash: string; timestamp: number } | null;
}
export interface BroadcasterStatus {
    /** Optional machine-readable rejection reason, including CREDIT_PERIOD_CHANGED. */
    reasonCode?: string;
    publishAfter?: string;
    executeBefore?: string;
    confirmation?: BroadcasterConfirmation;
    id: string;
    state:
        | "scheduled"
        | "preparing"
        | "cancelled"
        | "pending"
        | "submitted"
        | "confirmed"
        | "reverted"
        | "uncertain"
        | "queued"
        | "proving"
        | "rejected"
        | "expired";
    transactionHash?: string;
}
function checkedStatus(value: unknown, id?: string): BroadcasterStatus {
    const status = value as BroadcasterStatus;
    if (
        !status ||
        typeof status.id !== "string" ||
        !status.id.length ||
        status.id.length > 256 ||
        (id !== undefined && status.id !== id) ||
        (status.reasonCode !== undefined &&
            (typeof status.reasonCode !== "string" ||
                !status.reasonCode.length ||
                status.reasonCode.length > 256)) ||
        ![
            "scheduled",
            "preparing",
            "cancelled",
            "pending",
            "submitted",
            "confirmed",
            "reverted",
            "uncertain",
            "queued",
            "proving",
            "rejected",
            "expired",
        ].includes(status.state) ||
        (status.transactionHash !== undefined &&
            !/^0x[0-9a-fA-F]{64}$/.test(status.transactionHash))
    )
        throw new Error("invalid broadcaster status");
    if (
        (status.publishAfter !== undefined ||
            status.executeBefore !== undefined ||
            ["scheduled", "preparing", "cancelled"].includes(status.state)) &&
        (!canonicalScheduleSeconds(status.publishAfter) ||
            !canonicalScheduleSeconds(status.executeBefore) ||
            BigInt(status.publishAfter) >= BigInt(status.executeBefore))
    )
        throw Error("invalid broadcaster schedule status");
    if (status.confirmation !== undefined) {
        const confirmation = status.confirmation;
        if (
            !confirmation ||
            typeof confirmation !== "object" ||
            !["pending", "included", "safe", "finalized"].includes(confirmation.level) ||
            !["available", "unsupported", "unavailable", "inconsistent"].includes(
                confirmation.status
            ) ||
            [
                "scheduled",
                "preparing",
                "cancelled",
                "queued",
                "proving",
                "rejected",
                "expired",
            ].includes(status.state)
        )
            throw new Error("invalid broadcaster confirmation");
        const block = confirmation.block;
        if (
            block !== null &&
            (!block ||
                typeof block !== "object" ||
                typeof block.number !== "string" ||
                !/^(0|[1-9][0-9]*)$/.test(block.number) ||
                BigInt(block.number) >= 1n << 64n ||
                typeof block.hash !== "string" ||
                !/^0x[0-9a-fA-F]{64}$/.test(block.hash) ||
                !Number.isSafeInteger(block.timestamp) ||
                block.timestamp < 0)
        )
            throw new Error("invalid broadcaster confirmation block");
        if (
            confirmation.level === "pending"
                ? block !== null
                : !status.transactionHash ||
                  (block === null &&
                      (confirmation.status === "available" ||
                          confirmation.level === "safe" ||
                          confirmation.level === "finalized"))
        )
            throw new Error("invalid broadcaster confirmation anchor");
        return {
            ...status,
            confirmation: {
                level: confirmation.level,
                status: confirmation.status,
                block: block
                    ? { number: block.number, hash: block.hash, timestamp: block.timestamp }
                    : null,
            },
        };
    }
    return { ...status };
}
export type BroadcasterTransport = (
    request: { jsonrpc: "2.0"; id: number; method: string; params: unknown },
    options?: { signal?: AbortSignal }
) => Promise<unknown>;
export interface BroadcasterConfiguration {
    endpoint: string;
    quoteSigner: string;
    feeRecipient: string;
}
// Only the stateless encoder is shared. Preparation caches below are client-local;
// submission packets and mutable submission policy are never cached.
let sidecarEncoder:
    typeof import("@invisi-labs/protocol/provenance").proofSidecarToWire | undefined;
export class BroadcasterClient {
    readonly configuration: Readonly<BroadcasterConfiguration>;
    readonly url: string;
    readonly transport: BroadcasterTransport;
    private requestId = 0;
    // Bounded, client-local preparation data. Mutable submission policy is always read afresh.
    #preparation?: {
        binding: string;
        transport: BroadcasterTransport;
        methods: readonly unknown[];
        capabilities: Map<string, { expires: number; value: Promise<boolean> }>;
        tickets: Map<string, Promise<SignedBroadcasterFeeLock>>;
    };
    #issuedFeeLocks = new WeakMap<SignedBroadcasterFeeLock, () => void>();
    #preparationState() {
        const methods = [
            this.call,
            this.supportsToken,
            this.prepareCapabilities,
            this.lockFee,
            this.estimateQuote,
            this.getQuote,
            this.submissionRequirements,
        ];
        const binding = JSON.stringify([
            this.url,
            this.configuration.endpoint,
            this.configuration.quoteSigner,
            this.configuration.feeRecipient,
        ]);
        if (
            !this.#preparation ||
            this.#preparation.binding !== binding ||
            this.#preparation.transport !== this.transport ||
            methods.some((method, index) => this.#preparation!.methods[index] !== method)
        ) {
            this.#preparation = {
                binding,
                transport: this.transport,
                methods,
                capabilities: new Map(),
                tickets: new Map(),
            };
        }
        return this.#preparation;
    }
    #contextKey(context: { chainId: bigint; protocol: string }) {
        if (context.chainId <= 0n || BigInt(getAddress(context.protocol)) === 0n)
            throw Error("Invalid broadcaster context");
        return `${context.chainId}:${getAddress(context.protocol)}`;
    }
    /** Authenticate preparation capabilities during startup, without requesting a price. */
    async prepareCapabilities(context: { chainId: bigint; protocol: string }): Promise<void> {
        await this.#feeLockCapability({ ...context });
    }
    async #feeLockCapability(context: { chainId: bigint; protocol: string }): Promise<{
        supported: boolean;
        receipt: { expires: number; value: Promise<boolean> };
    }> {
        const state = this.#preparationState();
        const key = this.#contextKey(context);
        const cached = state.capabilities.get(key);
        if (cached && cached.expires > Date.now()) {
            const value = await cached.value;
            if (state.capabilities.get(key) !== cached) return this.#feeLockCapability(context);
            return { supported: value, receipt: cached };
        }
        // A refreshed service capability starts a new ticket generation.
        for (const ticketKey of state.tickets.keys())
            if (ticketKey.startsWith(`${key}:`)) state.tickets.delete(ticketKey);
        const entry = { expires: Date.now() + 300_000, value: Promise.resolve(false) };
        entry.value = (async () => {
            const { feeLockSupported } = await import("./service-status");
            try {
                const supported = await feeLockSupported(
                    this.call.bind(this),
                    this.configuration,
                    context
                );
                if (this.#preparationState() !== state)
                    throw Error("Broadcaster binding changed during preparation");
                return supported;
            } catch (error) {
                if (state.capabilities.get(key) === entry) state.capabilities.delete(key);
                throw error;
            }
        })();
        state.capabilities.delete(key);
        state.capabilities.set(key, entry);
        if (state.capabilities.size > 8)
            state.capabilities.delete(state.capabilities.keys().next().value!);
        const supported = await entry.value;
        if (state.capabilities.get(key) !== entry) return this.#feeLockCapability(context);
        return { supported, receipt: entry };
    }
    #copyFeeLock(ticket: SignedBroadcasterFeeLock, evict: () => void) {
        const copy = structuredClone(ticket);
        this.#issuedFeeLocks.set(copy, evict);
        return copy;
    }
    #evictFeeLock(ticket: SignedBroadcasterFeeLock) {
        this.#issuedFeeLocks.get(ticket)?.();
    }
    constructor(configuration: BroadcasterConfiguration, transport?: BroadcasterTransport) {
        if (
            Object.keys(configuration).some(
                (k) => !["endpoint", "quoteSigner", "feeRecipient"].includes(k)
            )
        )
            throw Error("Unknown broadcaster configuration field");
        this.configuration = Object.freeze({
            endpoint: configuration.endpoint,
            quoteSigner: getAddress(configuration.quoteSigner),
            feeRecipient: getAddress(configuration.feeRecipient),
        });
        if (
            BigInt(this.configuration.quoteSigner) === 0n ||
            BigInt(this.configuration.feeRecipient) === 0n
        )
            throw new Error("invalid broadcaster configuration");
        this.url = configuration.endpoint;
        const base = new URL(this.url);
        if (base.protocol !== "https:" || base.username || base.password)
            throw new Error("broadcaster requires HTTPS");

        this.transport =
            transport ??
            (async (request, options) => {
                const response = await fetch(base, {
                    redirect: "error",
                    method: "POST",
                    body: JSON.stringify(request),
                    headers: { "content-type": "application/json" },
                    signal: options?.signal
                        ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
                        : AbortSignal.timeout(30000),
                });
                if (!response.ok) throw new Error(`Broadcaster HTTP ${response.status}`);
                if (!response.body) throw new Error("empty broadcaster response");
                const reader = response.body.getReader();
                const chunks: Uint8Array[] = [];
                let size = 0;
                try {
                    while (true) {
                        const result = await reader.read();
                        if (result.done) break;
                        size += result.value.length;
                        if (size > 65536) throw new Error("broadcaster response too large");
                        chunks.push(result.value);
                    }
                } finally {
                    await reader.cancel();
                }
                const bytes = new Uint8Array(size);
                let offset = 0;
                for (const chunk of chunks) {
                    bytes.set(chunk, offset);
                    offset += chunk.length;
                }
                return JSON.parse(new TextDecoder().decode(bytes));
            });
    }
    async scheduling(context: {
        chainId: bigint;
        protocol: string;
    }): Promise<BroadcasterSchedulingCapabilities> {
        const { schedulingCapabilities } = await import("./service-status");
        return schedulingCapabilities(this.call.bind(this), this.configuration, context);
    }
    async supportsToken(
        tokenAddress: string,
        context: { chainId: bigint; protocol: string },
        options: { signal?: AbortSignal } = {}
    ): Promise<boolean> {
        context = { ...context };
        const state = this.#preparationState();
        const key = this.#contextKey(context);
        const { supportsToken } = await import("./service-status");
        return supportsToken(
            this.call.bind(this),
            this.configuration,
            tokenAddress,
            context,
            options.signal,
            (supported) => {
                if (this.#preparationState() !== state) return;
                for (const ticketKey of state.tickets.keys())
                    if (ticketKey.startsWith(`${key}:`)) state.tickets.delete(ticketKey);
                state.capabilities.delete(key);
                state.capabilities.set(key, {
                    expires: Date.now() + 300_000,
                    value: Promise.resolve(supported),
                });
                if (state.capabilities.size > 8)
                    state.capabilities.delete(state.capabilities.keys().next().value!);
            }
        );
    }

    /** Read only when preparing a first submission, never during construction or quotation. */
    async submissionRequirements(
        signed: SignedBroadcasterQuote
    ): Promise<{ provenanceRequired: boolean }> {
        const { submissionRequirements } = await import("./service-status");
        return submissionRequirements(this.call.bind(this), this.configuration, signed);
    }

    private async call(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
        const id = ++this.requestId;
        const response = (await this.transport(
            {
                jsonrpc: "2.0",
                id,
                method,
                params: params === undefined ? [] : [params],
            },
            signal ? { signal } : undefined
        )) as {
            jsonrpc?: string;
            id?: unknown;
            result?: unknown;
            error?: { code?: unknown; message?: unknown };
        };
        signal?.throwIfAborted();
        if (
            !response ||
            response.jsonrpc !== "2.0" ||
            response.id !== id ||
            Object.hasOwn(response, "result") === Object.hasOwn(response, "error")
        )
            throw new Error("invalid broadcaster JSON-RPC response");
        if (response.error) {
            if (
                !Number.isInteger(response.error.code) ||
                typeof response.error.message !== "string"
            )
                throw new Error("invalid broadcaster JSON-RPC error");
            throw new BroadcasterRpcError(response.error.code as number, response.error.message);
        }
        return response.result;
    }
    /** Missing capability keeps the legacy flow; advertised lock failures never downgrade. */
    async lockFee(
        data: string,
        context: { chainId: bigint; protocol: string }
    ): Promise<SignedBroadcasterFeeLock | undefined> {
        context = { ...context };
        const intent = decodeBroadcasterIntent(data);
        const token = getAddress(intent.request.params.token);
        const state = this.#preparationState();
        const capability = await this.#feeLockCapability(context);
        const contextKey = this.#contextKey(context);
        if (state.capabilities.get(contextKey) !== capability.receipt)
            return this.lockFee(data, context);
        if (this.#preparationState() !== state)
            throw Error("Broadcaster binding changed during preparation");
        if (!capability.supported) return undefined;
        const key = `${this.#contextKey(context)}:${token}`;
        const tickets = state.tickets;
        let pending = tickets.get(key);
        if (pending) {
            const cached = await pending;
            if (
                state.capabilities.get(contextKey) !== capability.receipt ||
                tickets !== state.tickets ||
                tickets.get(key) !== pending
            )
                return this.lockFee(data, context);
            if (this.#preparationState() !== state)
                throw Error("Broadcaster binding changed during preparation");
            try {
                verifyBroadcasterFeeLock(
                    cached,
                    { ...context, signer: this.configuration.quoteSigner },
                    token,
                    this.configuration.feeRecipient
                );
                const retained = pending;
                return this.#copyFeeLock(cached, () => {
                    if (this.#preparationState() === state && tickets.get(key) === retained)
                        tickets.delete(key);
                });
            } catch {
                if (tickets.get(key) === pending) tickets.delete(key);
                else return this.lockFee(data, context);
            }
        }
        pending = (async () => {
            const ticket = (await this.call("broadcaster_lockFee", {
                data,
            })) as SignedBroadcasterFeeLock;
            if (this.#preparationState() !== state)
                throw Error("Broadcaster binding changed during preparation");
            verifyBroadcasterFeeLock(
                ticket,
                { ...context, signer: this.configuration.quoteSigner },
                token,
                this.configuration.feeRecipient
            );
            return structuredClone(ticket);
        })();
        tickets.set(key, pending);
        if (tickets.size > 16) tickets.delete(tickets.keys().next().value!);
        try {
            const ticket = await pending;
            if (
                state.capabilities.get(contextKey) !== capability.receipt ||
                tickets !== state.tickets ||
                tickets.get(key) !== pending
            )
                return this.lockFee(data, context);
            const retained = pending;
            return this.#copyFeeLock(ticket, () => {
                if (this.#preparationState() === state && tickets.get(key) === retained)
                    tickets.delete(key);
            });
        } catch (error) {
            if (tickets.get(key) === pending) tickets.delete(key);
            throw error;
        }
    }

    async estimateQuote(
        input:
            | string
            | { data: string; schedule?: BroadcasterSchedule; feeLock?: SignedBroadcasterFeeLock }
    ): Promise<BroadcasterEstimate> {
        const { data, schedule, feeLock } = typeof input === "string" ? { data: input } : input;
        if (schedule) checkedSchedule(schedule);
        decodeBroadcasterIntent(data);
        const estimate = (await this.call("broadcaster_estimateQuote", {
            data,
            ...(schedule ? { schedule } : {}),
            ...(feeLock ? { feeLock } : {}),
        }).catch((error) => {
            if (feeLock) this.#evictFeeLock(feeLock);
            throw error;
        })) as BroadcasterEstimate;
        if (
            !estimate ||
            Object.keys(estimate).some(
                (k) => !["feeRecipient", "feeAmount", "maxGas"].includes(k)
            ) ||
            getAddress(estimate.feeRecipient) !== this.configuration.feeRecipient ||
            !/^[0-9]+$/.test(estimate.feeAmount) ||
            BigInt(estimate.feeAmount) <= 0n ||
            BigInt(estimate.feeAmount) >= 1n << 128n ||
            !/^[0-9]+$/.test(estimate.maxGas) ||
            BigInt(estimate.maxGas) <= 0n
        )
            throw Error("invalid broadcaster estimate");
        return { ...estimate };
    }
    async getQuote(
        input:
            | string
            | { data: string; schedule?: BroadcasterSchedule; feeLock?: SignedBroadcasterFeeLock },
        context: { chainId: bigint; protocol: string }
    ): Promise<SignedBroadcasterQuote> {
        const { data, schedule, feeLock } = typeof input === "string" ? { data: input } : input;
        if (schedule) checkedSchedule(schedule);
        decodeBroadcasterIntent(data);
        const signed = (await this.call("broadcaster_getQuote", {
            data,
            ...(schedule ? { schedule } : {}),
            ...(feeLock ? { feeLock } : {}),
        }).catch((error) => {
            if (feeLock) this.#evictFeeLock(feeLock);
            throw error;
        })) as SignedBroadcasterQuote;
        if (
            schedule
                ? !signed.quote?.schedule ||
                  Object.entries(schedule).some(
                      ([key, value]) =>
                          signed.quote.schedule![key as keyof BroadcasterSchedule] !== value
                  )
                : signed.quote?.schedule !== undefined
        )
            throw Error("broadcaster schedule mismatch");
        verifyBroadcasterQuote(
            signed,
            {
                ...context,
                signer: this.configuration.quoteSigner,
            },
            data
        );
        if (feeLock) {
            verifyBroadcasterFeeLock(
                feeLock,
                { ...context, signer: this.configuration.quoteSigner },
                signed.quote.token,
                this.configuration.feeRecipient
            );
            if (
                BigInt(signed.quote.deadline) > BigInt(feeLock.lock.deadline) ||
                BigInt(signed.quote.maxGas) > BigInt(feeLock.lock.maxGas)
            )
                throw Error("Quote exceeds fee lock bounds");
        }
        if (getAddress(signed.quote.feeRecipient) !== this.configuration.feeRecipient)
            throw new Error("unregistered fee recipient");
        return {
            quote: signed.quote,
            signature: signed.signature,
            context: { ...context },
            ...(signed.provenanceRequired === undefined
                ? {}
                : { provenanceRequired: signed.provenanceRequired }),
            ...(signed.requestHashFormat === undefined
                ? {}
                : { requestHashFormat: signed.requestHashFormat }),
        };
    }
    /** @internal Load the optional codec before a managed first-send fence. */
    async prepareSubmissionEncoding(): Promise<void> {
        sidecarEncoder ??= (await import("@invisi-labs/protocol/provenance")).proofSidecarToWire;
    }
    async submitTransaction(
        data: string,
        signed: SignedBroadcasterQuote,
        proofSidecars: readonly ProofSidecar[] = [],
        memberProof?: BroadcasterMemberProof
    ): Promise<BroadcasterStatus> {
        if (!Array.isArray(proofSidecars)) throw Error("proofSidecars must be an array");
        if (signed.provenanceRequired !== true && proofSidecars.length)
            throw Error("Quote does not accept provenance evidence");
        if (!signed.context) throw new Error("missing verified quote context");
        verifyBroadcasterQuote(
            signed,
            {
                ...signed.context,
                signer: this.configuration.quoteSigner,
            },
            data,
            0n
        );
        if (getAddress(signed.quote.feeRecipient) !== this.configuration.feeRecipient)
            throw new Error("unregistered fee recipient");
        if ((signed.quote.execution === "aggregate") !== (memberProof !== undefined))
            throw Error("quote execution and member proof mismatch");
        const member =
            memberProof === undefined ? undefined : checkedMemberProof(data, memberProof);
        // Managed first sends preload the codec before their authority check.
        // Raw RPC clients and frozen retries load it on demand for actual evidence.
        if (proofSidecars.length && !sidecarEncoder) await this.prepareSubmissionEncoding();
        return checkedStatus(
            await this.call("broadcaster_submitTransaction", {
                data,
                quote: signed.quote,
                signature: signed.signature,
                ...(member === undefined ? {} : { memberProof: member }),
                ...(signed.provenanceRequired !== true
                    ? {}
                    : { proofSidecars: proofSidecars.map((sidecar) => sidecarEncoder!(sidecar)) }),
            })
        );
    }
    async cancelTransaction(id: string, cancelToken: string): Promise<BroadcasterStatus> {
        if (
            typeof id !== "string" ||
            !id.length ||
            id.length > 256 ||
            !/^0x[0-9a-fA-F]{64}$/.test(cancelToken)
        )
            throw Error("Invalid broadcaster cancellation");
        return checkedStatus(
            await this.call("broadcaster_cancelTransaction", { id, cancelToken }),
            id
        );
    }
    async status(id: string): Promise<BroadcasterStatus> {
        if (typeof id !== "string" || !id.length || id.length > 256)
            throw Error("Invalid broadcaster submission ID");
        return checkedStatus(await this.call("broadcaster_getTransactionStatus", { id }), id);
    }
}
export class BroadcasterRpcError extends Error {
    constructor(
        readonly code: number,
        message: string
    ) {
        super(message);
        this.name = "BroadcasterRpcError";
    }
}
