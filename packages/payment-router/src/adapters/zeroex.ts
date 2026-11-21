import { ZeroAddress } from "ethers";
import { snapshotQuoteRequest } from "../quote-request";
import type { SwapQuoteAdapter, SwapQuoteRequest, ZeroExQuote } from "../types";
import { NATIVE_TOKEN, validateZeroExPayload } from "../codecs";
import { address, check, decimal, record, same, text, uint } from "../validation";
export type ZeroExQuoteTransport = (request: SwapQuoteRequest) => Promise<unknown>;
export class ZeroExAdapter implements SwapQuoteAdapter {
    readonly channel = "zeroex" as const;
    readonly #transport: ZeroExQuoteTransport;
    constructor(options: { transport: ZeroExQuoteTransport }) {
        this.#transport = options.transport;
    }
    async quote(input: SwapQuoteRequest): Promise<ZeroExQuote> {
        const request = snapshotQuoteRequest(input);
        request.signal?.throwIfAborted();
        check(
            request.deployment.zeroEx && request.settlerAddress,
            "0x deployment and current Settler required"
        );
        uint(request.maxInput, 256, "ETH budget", true);
        uint(request.amountOut, 128, "funding amount", true);
        uint(request.deadline, 64, "quote deadline");
        const bps = request.slippageBps ?? 50;
        check(Number.isInteger(bps) && bps >= 0 && bps <= 10000, "invalid slippageBps");
        check(request.deadline >= request.now, "quote expired");
        const body = record(await this.#transport(snapshotQuoteRequest(request)), "0x quote");
        request.signal?.throwIfAborted();
        check(body.liquidityAvailable === true, "0x liquidity is unavailable");
        check(same(text(body.buyToken, "buyToken"), request.tokenOut), "0x buy token mismatch");
        check(
            same(
                text(body.sellToken, "sellToken"),
                request.tokenIn && !same(request.tokenIn, ZeroAddress)
                    ? request.tokenIn
                    : NATIVE_TOKEN
            ),
            "0x sell token must be native ETH"
        );
        check(decimal(body.buyAmount, "buyAmount") === request.amountOut, "0x buy amount mismatch");
        const maxInput = decimal(body.maxSellAmount, "maxSellAmount");
        check(maxInput > 0n && maxInput <= request.maxInput, "0x quote exceeds ETH budget");
        const tx = record(body.transaction, "0x transaction");
        check(
            decimal(tx.value, "transaction value") ===
                (request.tokenIn && !same(request.tokenIn, ZeroAddress) ? 0n : maxInput),
            "0x native transaction value mismatch"
        );
        for (const field of ["taker", "recipient"]) {
            if (body[field] !== undefined)
                check(
                    same(text(body[field], field), request.deployment.routerAddress),
                    `0x ${field} mismatch`
                );
        }
        for (const id of [body.chainId, tx.chainId])
            if (id !== undefined)
                check(
                    (typeof id === "number" && Number.isSafeInteger(id)
                        ? BigInt(id)
                        : decimal(id, "chainId")) === request.deployment.chainId,
                    "0x quote chain mismatch"
                );
        const checked = validateZeroExPayload({
            ...(request.tokenIn ? { tokenIn: request.tokenIn } : {}),
            target: address(text(tx.to, "transaction target")),
            data: text(tx.data, "transaction data") as `0x${string}`,
            routerAddress: request.deployment.routerAddress,
            tokenOut: request.tokenOut,
            amountOut: request.amountOut,
            maxInput,
            settlerAddress: request.settlerAddress,
            allowanceHolderAddress: request.deployment.zeroEx.allowanceHolderAddress,
            now: request.now,
        });
        const estimatedInput =
            body.sellAmount === undefined ? maxInput : decimal(body.sellAmount, "sellAmount");
        check(estimatedInput <= maxInput, "0x estimated input exceeds budget");
        return Object.freeze({
            channel: this.channel,
            ...(request.tokenIn ? { tokenIn: request.tokenIn } : {}),
            chainId: request.deployment.chainId,
            routerAddress: request.deployment.routerAddress,
            tokenOut: address(request.tokenOut),
            amountOut: request.amountOut,
            estimatedInput,
            maxInput,
            deadline:
                checked.nativeDeadline < request.deadline
                    ? checked.nativeDeadline
                    : request.deadline,
            target: checked.target,
            data: checked.data,
            settlerAddress: checked.settlerAddress,
        });
    }
}
export interface ZeroExHttpOptions {
    /** Backend-only credential. Never inferred from environment variables or logged. */
    apiKey: string;
    endpoint?: string;
    fetch?: typeof globalThis.fetch;
}
/** Explicit HTTP transport for backend use; browser applications should inject a backend proxy. */
export function createZeroExQuoteFetcher(options: ZeroExHttpOptions): ZeroExQuoteTransport {
    check(
        typeof options.apiKey === "string" && options.apiKey.trim().length > 0,
        "0x API key required"
    );
    const endpoint = new URL(options.endpoint ?? "https://api.0x.org/swap/allowance-holder/quote");
    check(
        endpoint.protocol === "https:" &&
            !endpoint.username &&
            !endpoint.password &&
            !endpoint.search &&
            !endpoint.hash,
        "0x endpoint must be an HTTPS URL without credentials or query parameters"
    );
    const fetcher = options.fetch ?? globalThis.fetch;
    check(typeof fetcher === "function", "fetch transport required");
    const key = options.apiKey;
    return async (request) => {
        request.signal?.throwIfAborted();
        const url = new URL(endpoint);
        url.search = new URLSearchParams({
            chainId: request.deployment.chainId.toString(),
            sellToken:
                request.tokenIn && !same(request.tokenIn, ZeroAddress)
                    ? request.tokenIn
                    : NATIVE_TOKEN,
            buyToken: request.tokenOut,
            buyAmount: request.amountOut.toString(),
            taker: request.deployment.routerAddress,
            recipient: request.deployment.routerAddress,
            slippageBps: String(request.slippageBps ?? 50),
        }).toString();
        let response: Response;
        try {
            response = await fetcher(url, {
                headers: { "0x-api-key": key, "0x-version": "v2" },
                ...(request.signal ? { signal: request.signal } : {}),
                redirect: "error",
            });
        } catch {
            request.signal?.throwIfAborted();
            throw new Error("0x quote request failed");
        }
        check(response.ok, `0x quote HTTP ${response.status}`);
        try {
            return await response.json();
        } catch {
            throw new Error("Invalid 0x quote JSON response");
        }
    };
}
