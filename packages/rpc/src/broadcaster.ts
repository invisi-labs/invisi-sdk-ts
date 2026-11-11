import { provenanceIntentHash } from "@invisi-labs/primitives";
import type { ProofSidecar } from "@invisi-labs/protocol/provenance";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
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
export interface BroadcasterQuote {
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
const intentAbi = invisiProtocolAbi.filter(
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
                    shard: decoded[2],
                    slot: decoded[3],
                    deadline: decoded[4],
                    feeRecipient: decoded[5],
                    feeAmount: decoded[6],
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
    if (method === "revokeCredit") canonical[7] = "0x";
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
                broadcasterQuoteTypes,
                quote,
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
export interface BroadcasterStatus {
    id: string;
    state:
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
        ![
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
    return status;
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
export class BroadcasterClient {
    readonly configuration: Readonly<BroadcasterConfiguration>;
    readonly url: string;
    readonly transport: BroadcasterTransport;
    private requestId = 0;
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
    async supportsToken(
        tokenAddress: string,
        context: { chainId: bigint; protocol: string },
        options: { signal?: AbortSignal } = {}
    ): Promise<boolean> {
        const { supportsToken } = await import("./service-status");
        return supportsToken(
            this.call.bind(this),
            this.configuration,
            tokenAddress,
            context,
            options.signal
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
    async estimateQuote(data: string): Promise<BroadcasterEstimate> {
        decodeBroadcasterIntent(data);
        const estimate = (await this.call("broadcaster_estimateQuote", {
            data,
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
        data: string,
        context: { chainId: bigint; protocol: string }
    ): Promise<SignedBroadcasterQuote> {
        decodeBroadcasterIntent(data);
        const signed = (await this.call("broadcaster_getQuote", {
            data,
        })) as SignedBroadcasterQuote;
        verifyBroadcasterQuote(
            signed,
            {
                ...context,
                signer: this.configuration.quoteSigner,
            },
            data
        );
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
        const { proofSidecarToWire } = await import("@invisi-labs/protocol/provenance");
        return checkedStatus(
            await this.call("broadcaster_submitTransaction", {
                data,
                quote: signed.quote,
                signature: signed.signature,
                ...(member === undefined ? {} : { memberProof: member }),
                ...(signed.provenanceRequired !== true
                    ? {}
                    : { proofSidecars: proofSidecars.map(proofSidecarToWire) }),
            })
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
