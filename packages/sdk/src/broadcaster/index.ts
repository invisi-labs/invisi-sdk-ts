import { AbiCoder, getAddress, Interface, keccak256, verifyTypedData } from "ethers";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";

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
export interface SignedBroadcasterQuote {
    quote: BroadcasterQuote;
    signature: string;
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
const transactAbi = invisiProtocolAbi.filter(
    (item) =>
        item.type === "function" && item.name === "transact" && item.inputs[1]?.type === "tuple"
);
export const broadcasterTransactInterface = new Interface(transactAbi);
/** Decode only canonical single-request transact calldata; aggregates are deliberately unsupported. */
export function decodeBroadcasterIntent(data: string) {
    const fragment = broadcasterTransactInterface.getFunction("transact");
    if (!fragment) throw new Error("transact ABI unavailable");
    const decoded = broadcasterTransactInterface.decodeFunctionData(fragment, data);
    if (
        broadcasterTransactInterface.encodeFunctionData(fragment, decoded).toLowerCase() !==
        data.toLowerCase()
    )
        throw new Error("noncanonical transact calldata");
    return { fragment, proof: decoded[0] as string, request: decoded[1] };
}
/** Final intent binds every request field including permit, except the funding signature and proof. */
export function broadcasterRequestHash(data: string): string {
    const { fragment, request } = decodeBroadcasterIntent(data);
    const params = fragment.inputs[1]!.components![0]!;
    const deliveries = fragment.inputs[1]!.components![1]!;
    const funding = request.funding;
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            [
                "string",
                params,
                deliveries,
                "address",
                "uint256",
                "uint256",
                "uint256",
                "tuple(uint256 deadline,uint8 v,bytes32 r,bytes32 s)",
            ],
            [
                "InvisiBroadcasterIntentV1",
                request.params,
                request.deliveries,
                funding.payer,
                funding.amount,
                funding.sigNonce,
                funding.deadline,
                funding.permit,
            ]
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
    const { request } = decodeBroadcasterIntent(data);
    const p = request.params;
    if (
        quote.requestHash !== broadcasterRequestHash(data) ||
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
function checkedStatus(value: unknown, id: string): BroadcasterStatus {
    const status = value as BroadcasterStatus;
    if (
        !status ||
        status.id !== id ||
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
export class BroadcasterClient {
    readonly transport: BroadcasterTransport;
    private requestId = 0;
    constructor(
        readonly url: string,
        readonly trust: BroadcasterTrust,
        transport?: BroadcasterTransport
    ) {
        const base = new URL(url);
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
        const response = (await this.transport({ jsonrpc: "2.0", id, method, params })) as {
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
    async fee(token: string): Promise<{ feeRecipient: string; feeAmount: string; maxGas: string }> {
        return (await this.call("broadcaster_getFee", { token: getAddress(token) })) as never;
    }
    async quote(data: string): Promise<SignedBroadcasterQuote> {
        const signed = (await this.call("broadcaster_getQuote", {
            data,
        })) as SignedBroadcasterQuote;
        verifyBroadcasterQuote(signed, this.trust, data);
        return signed;
    }
    async submit(
        data: string,
        signed: SignedBroadcasterQuote,
        idempotencyKey: string
    ): Promise<BroadcasterStatus> {
        verifyBroadcasterQuote(signed, this.trust, data, 0n);
        return checkedStatus(
            await this.call("broadcaster_submitTransaction", { data, ...signed, idempotencyKey }),
            idempotencyKey
        );
    }
    async status(id: string): Promise<BroadcasterStatus> {
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
