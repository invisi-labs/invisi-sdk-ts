import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import type { TransactionCall } from "@invisi-labs/protocol";
import type { Invisi, ExplicitTransferPreparation, PreparedTransaction } from "@invisi-labs/sdk";

/** Explicit trusted deployment. 0x is available only when its two dependencies are supplied. */
export interface PaymentRouterDeployment {
    chainId: bigint;
    routerAddress: Address;
    coreAddress: Address;
    wethAddress: Address;
    uniswapRouterAddress: Address;
    runtimeCodeHash?: Hex;
    zeroEx?: { allowanceHolderAddress: Address; settlerRegistryAddress: Address };
}
export interface QuoteParameters {
    tokenOut: Address;
    amountOut: bigint;
    maxInput: bigint;
    deadline: bigint;
    slippageBps?: number;
    signal?: AbortSignal;
}
/** A chain snapshot supplied by the client; quote adapters do not choose deployment identities. */
export interface SwapQuoteRequest extends QuoteParameters {
    deployment: Readonly<PaymentRouterDeployment>;
    now: bigint;
    blockNumber: number;
    settlerAddress?: Address;
}
interface QuoteCommon {
    chainId: bigint;
    routerAddress: Address;
    tokenOut: Address;
    amountOut: bigint;
    estimatedInput: bigint;
    maxInput: bigint;
    deadline: bigint;
}
export interface UniswapV3Quote extends QuoteCommon {
    channel: "uniswap-v3";
    reversePath: Hex;
}
export interface ZeroExQuote extends QuoteCommon {
    channel: "zeroex";
    target: Address;
    data: Hex;
    settlerAddress: Address;
}
export type SwapQuote = UniswapV3Quote | ZeroExQuote;
export interface SwapQuoteAdapter {
    readonly channel: SwapQuote["channel"];
    quote(request: SwapQuoteRequest): Promise<SwapQuote>;
}
/** Host retains wallet capabilities and proof lifecycle. No private inputs are selected. */
export type PrepareRouterPayment = Pick<
    ExplicitTransferPreparation,
    "wallet" | "protocol" | "tokenAddress" | "outputs" | "fee" | "deadline"
> & { invisi: Invisi };
export type CorePayment = PreparedTransaction | TransactionCall;
export interface RouterSimulation {
    gasEstimate: bigint;
    ethSpent: bigint;
    ethRefunded: bigint;
}
