import { provenanceIntentHash } from "@invisi-labs/core";
import type { ProofSidecar } from "@invisi-labs/core/provenance";
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
    ],
};
export interface BroadcasterQuote {
    token: string;
    feeRecipient: string;
    feeAmount: string;
    deadline: string;
    maxGas: string;
    requestHash: string;
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
    provenanceTracking?: import("@invisi-labs/core/provenance").Tracking;
    requestHashFormat?: string;
    context?: { chainId: bigint; protocol: string };
}
export interface BroadcasterTrust {
    chainId: bigint;
    protocol: string;
    signer: string;
    provenanceRequired?: boolean;
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
                    "provenanceTracking",
                    "requestHashFormat",
                ].includes(k)
        )
    )
        throw Error("Unknown broadcaster quote field");
    const required = trust.provenanceRequired === true;
    if (
        required
            ? signed.provenanceRequired !== true ||
              signed.requestHashFormat !== "invisi-broadcaster-provenance-intent-v1"
            : signed.provenanceRequired !== undefined ||
              signed.requestHashFormat !== undefined ||
              signed.provenanceTracking !== undefined
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
export interface BroadcasterStatus {
    id: string;
    state: "pending" | "submitted" | "confirmed" | "reverted" | "uncertain";
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
        !["pending", "submitted", "confirmed", "reverted", "uncertain"].includes(status.state) ||
        (status.transactionHash !== undefined &&
            !/^0x[0-9a-fA-F]{64}$/.test(status.transactionHash))
    )
        throw new Error("invalid broadcaster status");
    return status;
}
export type BroadcasterTransport = (request: {
    jsonrpc: "2.0";
    id: number;
    method: string;
    params: unknown;
}) => Promise<unknown>;
export interface BroadcasterConfiguration {
    endpoint: string;
    quoteSigner: string;
    feeRecipient: string;
    provenanceRequired?: boolean;
}
export class BroadcasterClient {
    readonly configuration: Readonly<BroadcasterConfiguration>;
    readonly url: string;
    readonly transport: BroadcasterTransport;
    private requestId = 0;
    constructor(configuration: BroadcasterConfiguration, transport?: BroadcasterTransport) {
        if (
            Object.keys(configuration).some(
                (k) =>
                    !["endpoint", "quoteSigner", "feeRecipient", "provenanceRequired"].includes(k)
            )
        )
            throw Error("Unknown broadcaster configuration field");
        this.configuration = Object.freeze({
            ...(configuration.provenanceRequired !== true
                ? {}
                : { provenanceRequired: configuration.provenanceRequired }),
            endpoint: configuration.endpoint,
            quoteSigner: getAddress(configuration.quoteSigner),
            feeRecipient: getAddress(configuration.feeRecipient),
        });
        if (
            BigInt(this.configuration.quoteSigner) === 0n ||
            BigInt(this.configuration.feeRecipient) === 0n
        )
            throw new Error("invalid broadcaster configuration");
        if (
            configuration.provenanceRequired !== undefined &&
            typeof configuration.provenanceRequired !== "boolean"
        )
            throw new Error("invalid broadcaster provenance requirement");
        this.url = configuration.endpoint;
        const base = new URL(this.url);
        if (base.protocol !== "https:" || base.username || base.password)
            throw new Error("broadcaster requires HTTPS");

        this.transport =
            transport ??
            (async (request) => {
                const response = await fetch(base, {
                    redirect: "error",
                    method: "POST",
                    body: JSON.stringify(request),
                    headers: { "content-type": "application/json" },
                    signal: AbortSignal.timeout(30000),
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
    private async call(method: string, params: unknown): Promise<unknown> {
        const id = ++this.requestId;
        const response = (await this.transport({
            jsonrpc: "2.0",
            id,
            method,
            params: [params],
        })) as {
            jsonrpc?: string;
            id?: unknown;
            result?: unknown;
            error?: { code?: unknown; message?: unknown };
        };
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
    async quote(
        data: string,
        context: { chainId: bigint; protocol: string },
        proofSidecars: readonly ProofSidecar[] = []
    ): Promise<SignedBroadcasterQuote> {
        decodeBroadcasterIntent(data);
        const { proofSidecarToWire, validateTracking } =
            await import("@invisi-labs/core/provenance");
        const signed = (await this.call("broadcaster_getQuote", {
            data,
            ...(this.configuration.provenanceRequired !== true
                ? {}
                : { proofSidecars: proofSidecars.map(proofSidecarToWire) }),
        })) as SignedBroadcasterQuote;
        verifyBroadcasterQuote(
            signed,
            {
                ...context,
                signer: this.configuration.quoteSigner,
                ...(this.configuration.provenanceRequired !== true
                    ? {}
                    : { provenanceRequired: this.configuration.provenanceRequired }),
            },
            data
        );
        if (getAddress(signed.quote.feeRecipient) !== this.configuration.feeRecipient)
            throw new Error("unregistered fee recipient");
        if (signed.provenanceTracking !== undefined) validateTracking(signed.provenanceTracking);
        return {
            quote: signed.quote,
            signature: signed.signature,
            context: { ...context },
            ...(signed.provenanceTracking === undefined
                ? {}
                : { provenanceTracking: structuredClone(signed.provenanceTracking) }),
            ...(signed.provenanceRequired === undefined
                ? {}
                : { provenanceRequired: signed.provenanceRequired }),
            ...(signed.requestHashFormat === undefined
                ? {}
                : { requestHashFormat: signed.requestHashFormat }),
        };
    }
    async submit(
        data: string,
        signed: SignedBroadcasterQuote,
        proofSidecars: readonly ProofSidecar[] = []
    ): Promise<BroadcasterStatus> {
        if (!Array.isArray(proofSidecars)) throw Error("proofSidecars must be an array");
        if (!signed.context) throw new Error("missing verified quote context");
        verifyBroadcasterQuote(
            signed,
            {
                ...signed.context,
                signer: this.configuration.quoteSigner,
                ...(this.configuration.provenanceRequired !== true
                    ? {}
                    : { provenanceRequired: this.configuration.provenanceRequired }),
            },
            data,
            0n
        );
        if (getAddress(signed.quote.feeRecipient) !== this.configuration.feeRecipient)
            throw new Error("unregistered fee recipient");
        const { proofSidecarToWire } = await import("@invisi-labs/core/provenance");
        return checkedStatus(
            await this.call("broadcaster_submitTransaction", {
                data,
                quote: signed.quote,
                signature: signed.signature,
                ...(this.configuration.provenanceRequired !== true
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
