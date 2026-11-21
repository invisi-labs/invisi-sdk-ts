import { Interface, verifyTypedData } from "ethers";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import type { TransactionCall } from "@invisi-labs/protocol";
import { paymentRouterAbi, paymentRouterAccountAbi } from "./canonical-abi";
import { coreInterface } from "./core-payment";
import {
    hashRelayEnvelope,
    hashRouterIntent,
    relayDraftEnvelope,
    relayEnvelope,
    PAYMENT_ROUTER_ENVELOPE_HASH_FORMAT,
    PAYMENT_ROUTER_INTENT_HASH_FORMAT,
    type RouterAuthorization,
} from "./canonical";
import { address, check, decimal, hex, record, same, uint } from "./validation";

export interface RouterRelayInput {
    coreCalldata: Hex;
    outer: TransactionCall;
    authorizationList?: RouterAuthorization[];
}
export interface RouterBroadcasterTrust {
    chainId: bigint;
    core: Address;
    quoteSigner: Address;
    feeRecipient: Address;
}
export interface RouterBroadcasterQuote {
    token: Address;
    feeRecipient: Address;
    feeAmount: string;
    deadline: string;
    maxGas: string;
    requestHash: Hex;
    execution: "direct";
}
export interface SignedRouterBroadcasterQuote {
    quote: RouterBroadcasterQuote;
    signature: Hex;
    requestHashFormat:
        typeof PAYMENT_ROUTER_ENVELOPE_HASH_FORMAT | typeof PAYMENT_ROUTER_INTENT_HASH_FORMAT;
    provenanceRequired?: boolean;
}
export interface RouterBroadcasterEstimate {
    feeRecipient: Address;
    feeAmount: string;
    maxGas: string;
}
export interface RouterBroadcasterStatus {
    id: string;
    state:
        "pending" | "submitted" | "confirmed" | "reverted" | "uncertain" | "rejected" | "expired";
    transactionHash?: Hex;
}
export type RouterBroadcasterTransport = (
    request: { jsonrpc: "2.0"; id: number; method: string; params: unknown[] },
    options?: { signal?: AbortSignal }
) => Promise<unknown>;
export const routerBroadcasterQuoteTypes = {
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
export function routerBroadcasterQuoteDomain(trust: RouterBroadcasterTrust) {
    return {
        name: "InvisiBroadcaster",
        version: "1",
        chainId: uint(trust.chainId, 256, "chain ID", true),
        verifyingContract: address(trust.core),
    };
}
function snapshotInput(input: RouterRelayInput): RouterRelayInput {
    return {
        ...structuredClone({ coreCalldata: input.coreCalldata, outer: input.outer }),
        ...(input.authorizationList
            ? {
                  authorizationList: input.authorizationList.map((a) => ({
                      ...a,
                      signature: {
                          yParity: a.signature.yParity,
                          r: a.signature.r,
                          s: a.signature.s,
                      },
                  })),
              }
            : {}),
    };
}
const router = new Interface(paymentRouterAbi),
    account = new Interface(paymentRouterAccountAbi);
function paymentBounds(input: RouterRelayInput) {
    relayDraftEnvelope(input.coreCalldata, input.outer, input.authorizationList);
    const [, request] = coreInterface.decodeFunctionData("transact", input.coreCalldata);
    let inner = input.outer.data,
        deadline = request.params.deadline as bigint;
    if (inner.slice(0, 10) === account.getFunction("executeNativePayment")!.selector) {
        const args = account.decodeFunctionData("executeNativePayment", inner);
        inner = args[0];
        if (args[3] < deadline) deadline = args[3];
    }
    const parsed = router.parseTransaction({ data: inner })!;
    if (parsed.args[2].deadline < deadline) deadline = parsed.args[2].deadline;
    return { request, deadline };
}
/** Verify an envelope-bound quote using the locally encoded transaction, never a caller-supplied hash. */
export function verifyRouterBroadcasterQuote(
    signed: SignedRouterBroadcasterQuote,
    trust: RouterBroadcasterTrust,
    input: RouterRelayInput,
    now = BigInt(Math.floor(Date.now() / 1000))
): RouterBroadcasterQuote {
    const s = record(signed, "Router quote");
    check(
        Object.keys(s).length === (s.provenanceRequired === undefined ? 3 : 4) &&
            Object.keys(s).every((k) =>
                ["quote", "signature", "requestHashFormat", "provenanceRequired"].includes(k)
            ) &&
            (s.provenanceRequired === undefined || typeof s.provenanceRequired === "boolean") &&
            (s.requestHashFormat === PAYMENT_ROUTER_ENVELOPE_HASH_FORMAT ||
                s.requestHashFormat === PAYMENT_ROUTER_INTENT_HASH_FORMAT),
        "invalid Router quote format"
    );
    const q = record(signed.quote, "quote"),
        fields = routerBroadcasterQuoteTypes.Quote.map((f) => f.name);
    check(
        Object.keys(q).length === fields.length &&
            Object.keys(q).every((k) => fields.includes(k)) &&
            q.execution === "direct",
        "invalid Router quote fields or execution"
    );
    const fee = decimal(q.feeAmount, "quote fee"),
        deadline = decimal(q.deadline, "quote deadline"),
        gas = decimal(q.maxGas, "quote gas");
    const { request, deadline: maximumDeadline } = paymentBounds(input),
        p = request.params;
    check(
        same(signed.quote.token, p.token) &&
            same(signed.quote.feeRecipient, p.feeRecipient) &&
            same(signed.quote.feeRecipient, address(trust.feeRecipient)) &&
            fee === p.feeAmount &&
            fee > 0n &&
            fee < 1n << 128n &&
            fee <= request.funding.amount &&
            gas > 0n &&
            deadline >= now &&
            deadline <= maximumDeadline,
        "Router quote does not match payment or bounds"
    );
    check(
        hex(q.requestHash).toLowerCase() ===
            (signed.requestHashFormat === PAYMENT_ROUTER_INTENT_HASH_FORMAT
                ? hashRouterIntent
                : hashRelayEnvelope)(
                trust.chainId,
                trust.core,
                input.outer,
                input.authorizationList
            ),
        "Router quote envelope mismatch"
    );
    check(
        same(
            verifyTypedData(
                routerBroadcasterQuoteDomain(trust),
                routerBroadcasterQuoteTypes,
                signed.quote,
                hex(signed.signature)
            ),
            address(trust.quoteSigner)
        ),
        "untrusted Router quote signer"
    );
    return { ...signed.quote };
}
/** Dedicated direct Router RPC client. Ordinary Core quote verification uses a different hash format. */
export class PaymentRouterRelayClient {
    readonly #trust: Readonly<RouterBroadcasterTrust>;
    readonly #transport: RouterBroadcasterTransport;
    #requestId = 0;
    constructor(options: {
        endpoint: string;
        trust: RouterBroadcasterTrust;
        transport?: RouterBroadcasterTransport;
    }) {
        const endpoint = new URL(options.endpoint);
        check(
            endpoint.protocol === "https:" && !endpoint.username && !endpoint.password,
            "Broadcaster requires HTTPS without credentials"
        );
        routerBroadcasterQuoteDomain(options.trust);
        this.#trust = Object.freeze({
            ...options.trust,
            core: address(options.trust.core),
            quoteSigner: address(options.trust.quoteSigner),
            feeRecipient: address(options.trust.feeRecipient),
        });
        this.#transport =
            options.transport ??
            (async (request, options) => {
                const response = await fetch(endpoint, {
                    method: "POST",
                    redirect: "error",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(request),
                    signal: options?.signal
                        ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)])
                        : AbortSignal.timeout(30000),
                });
                check(response.ok, `Broadcaster HTTP ${response.status}`);
                check(response.body, "empty Broadcaster response");
                const reader = response.body.getReader(),
                    chunks: Uint8Array[] = [];
                let size = 0;
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        size += value.length;
                        check(size <= 65536, "Broadcaster response too large");
                        chunks.push(value);
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
    async #call(method: string, params: unknown, signal?: AbortSignal) {
        signal?.throwIfAborted();
        const id = ++this.#requestId;
        const response = record(
            await this.#transport(
                { jsonrpc: "2.0", id, method, params: [params] },
                signal ? { signal } : undefined
            ),
            "Broadcaster response"
        );
        signal?.throwIfAborted();
        check(
            response.jsonrpc === "2.0" &&
                response.id === id &&
                Object.hasOwn(response, "result") !== Object.hasOwn(response, "error"),
            "invalid Broadcaster JSON-RPC response"
        );
        if (response.error) {
            const error = record(response.error, "Broadcaster error");
            check(
                Number.isInteger(error.code) && typeof error.message === "string",
                "invalid Broadcaster error"
            );
            throw new Error(`Broadcaster RPC ${error.code}: ${error.message}`);
        }
        return response.result;
    }
    async estimateQuote(
        input: RouterRelayInput,
        options: { signal?: AbortSignal } = {}
    ): Promise<RouterBroadcasterEstimate> {
        const pinned = snapshotInput(input),
            wire = relayDraftEnvelope(pinned.coreCalldata, pinned.outer, pinned.authorizationList);
        const estimate = record(
            await this.#call("broadcaster_estimateQuote", wire, options.signal),
            "Router estimate"
        );
        check(
            Object.keys(estimate).length === 3 &&
                Object.keys(estimate).every((k) =>
                    ["feeRecipient", "feeAmount", "maxGas"].includes(k)
                ),
            "invalid Router estimate fields"
        );
        const fee = decimal(estimate.feeAmount, "estimated fee"),
            gas = decimal(estimate.maxGas, "estimated gas");
        check(
            same(String(estimate.feeRecipient), this.#trust.feeRecipient) &&
                fee > 0n &&
                fee < 1n << 128n &&
                gas > 0n,
            "invalid Router estimate"
        );
        return { ...estimate } as unknown as RouterBroadcasterEstimate;
    }
    /** Obtain the service's current Core-token fee floor before proving. */
    estimateRouterFee(input: RouterRelayInput, options: { signal?: AbortSignal } = {}) {
        return this.estimateQuote(input, options);
    }
    async getQuote(
        input: RouterRelayInput,
        options: { signal?: AbortSignal } = {}
    ): Promise<SignedRouterBroadcasterQuote> {
        const pinned = snapshotInput(input),
            wire = relayDraftEnvelope(pinned.coreCalldata, pinned.outer, pinned.authorizationList);
        const signed = (await this.#call(
            "broadcaster_getQuote",
            wire,
            options.signal
        )) as SignedRouterBroadcasterQuote;
        verifyRouterBroadcasterQuote(signed, this.#trust, pinned);
        return structuredClone(signed);
    }
    async submitTransaction(
        input: RouterRelayInput,
        signed: SignedRouterBroadcasterQuote,
        options: { signal?: AbortSignal } = {}
    ): Promise<RouterBroadcasterStatus> {
        const pinned = snapshotInput(input),
            quote = structuredClone(signed);
        verifyRouterBroadcasterQuote(quote, this.#trust, pinned);
        const wire = relayEnvelope(pinned.coreCalldata, pinned.outer, pinned.authorizationList);
        const status = record(
            await this.#call(
                "broadcaster_submitTransaction",
                { ...wire, quote: quote.quote, signature: quote.signature },
                options.signal
            ),
            "Router status"
        );
        check(
            typeof status.id === "string" &&
                status.id.length > 0 &&
                status.id.length <= 256 &&
                [
                    "pending",
                    "submitted",
                    "confirmed",
                    "reverted",
                    "uncertain",
                    "rejected",
                    "expired",
                ].includes(String(status.state)),
            "invalid Router status"
        );
        if (status.transactionHash !== undefined)
            check(hex(status.transactionHash).length === 66, "invalid Router transaction hash");
        return structuredClone(status) as unknown as RouterBroadcasterStatus;
    }
}
