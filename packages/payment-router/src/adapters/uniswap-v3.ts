import { snapshotQuoteRequest } from "../quote-request";
import type { Provider } from "ethers";
import type { Address } from "@invisi-labs/protocol/contracts";
import type { SwapQuoteAdapter, SwapQuoteRequest, UniswapV3Quote } from "../types";
import { encodeV3ExactOutputPath, quoterV2Interface } from "../codecs";
import { address, check, same, uint } from "../validation";
export interface UniswapV3AdapterOptions {
    provider: Provider;
    quoterAddress: Address;
    /** Forward token order, starting at WETH and ending at the requested output. */
    routes: readonly { tokens: readonly Address[]; fees: readonly number[] }[];
}
/** Quote configured original-V3 routes with QuoterV2 via eth_call; never sends a trade. */
export class UniswapV3Adapter implements SwapQuoteAdapter {
    readonly channel = "uniswap-v3" as const;
    readonly #provider: Provider;
    readonly #quoter: Address;
    readonly #routes: UniswapV3AdapterOptions["routes"];
    constructor(options: UniswapV3AdapterOptions) {
        this.#provider = options.provider;
        this.#quoter = address(options.quoterAddress);
        this.#routes = structuredClone(options.routes);
        check(this.#routes.length > 0, "at least one V3 route is required");
        for (const route of this.#routes) encodeV3ExactOutputPath(route.tokens, route.fees);
    }
    async quote(input: SwapQuoteRequest): Promise<UniswapV3Quote> {
        const request = snapshotQuoteRequest(input);
        request.signal?.throwIfAborted();
        check(
            (await this.#provider.getNetwork()).chainId === request.deployment.chainId,
            "V3 quoter chain mismatch"
        );
        uint(request.amountOut, 128, "funding amount", true);
        uint(request.maxInput, 256, "ETH budget", true);
        uint(request.deadline, 64, "quote deadline");
        check(request.deadline >= request.now, "quote expired");
        const bps = request.slippageBps ?? 50;
        check(
            Number.isInteger(bps) && bps >= 0 && bps <= 10000,
            "slippageBps must be an integer from 0 to 10000"
        );
        check(
            (await this.#provider.getCode(this.#quoter, request.blockNumber)) !== "0x",
            "missing QuoterV2 code"
        );
        const routes = this.#routes.filter(
            (r) =>
                same(r.tokens[0]!, request.deployment.wethAddress) &&
                same(r.tokens.at(-1)!, request.tokenOut)
        );
        const results = await Promise.allSettled(
            routes.map(async (route) => {
                const reversePath = encodeV3ExactOutputPath(route.tokens, route.fees);
                const data = quoterV2Interface.encodeFunctionData("quoteExactOutput", [
                    reversePath,
                    request.amountOut,
                ]);
                const [amount] = quoterV2Interface.decodeFunctionResult(
                    "quoteExactOutput",
                    await this.#provider.call({
                        to: this.#quoter,
                        data,
                        blockTag: request.blockNumber,
                    })
                );
                const estimatedInput = uint(amount, 256, "quoted input", true);
                const maxInput = (estimatedInput * BigInt(10000 + bps) + 9999n) / 10000n;
                check(maxInput <= request.maxInput, "V3 quote exceeds ETH budget");
                return {
                    channel: this.channel,
                    chainId: request.deployment.chainId,
                    routerAddress: request.deployment.routerAddress,
                    tokenOut: address(request.tokenOut),
                    amountOut: request.amountOut,
                    estimatedInput,
                    maxInput,
                    deadline: request.deadline,
                    reversePath,
                };
            })
        );
        request.signal?.throwIfAborted();
        const quotes = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
        check(quotes.length > 0, "No executable V3 route within the ETH budget");
        quotes.sort((a, b) =>
            a.estimatedInput < b.estimatedInput ? -1 : a.estimatedInput > b.estimatedInput ? 1 : 0
        );
        return Object.freeze(quotes[0]!);
    }
}
