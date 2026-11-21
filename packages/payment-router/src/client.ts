import { ZeroAddress, Interface, type Provider, type Authorization } from "ethers";
import type { PreparedTransaction } from "@invisi-labs/sdk";
import type { TransactionCall } from "@invisi-labs/protocol";
import type { Address } from "@invisi-labs/protocol/contracts";
import {
    buildPaymentIntent,
    buildRouterPayment,
    simulateOuterPayment,
    PaymentMode,
    RouteChannel,
    noSwapRoute,
    type PaymentIntent,
    type RouterPayment,
} from "./canonical";
import { paymentRouterAbi } from "./canonical-abi";
import { zeroExPaymentRouterAbi } from "./abi";
import { inspectCorePayment, coreInterface } from "./core-payment";
import { frame, assertFrame, normalizeDeployment, type DeploymentFrame } from "./deployment";
import { validateV3Path, validateZeroExPayload } from "./codecs";
import type {
    PaymentRouterDeployment,
    PrepareRouterPayment,
    SwapQuoteAdapter,
    SwapQuote,
    QuoteParameters,
    CorePayment,
    RouterSimulation,
} from "./types";
import { address, check, same, uint } from "./validation";
const routerInterface = new Interface(zeroExPaymentRouterAbi);

/** Detached quote/preparation/encoding client. Wallet signing and broadcasting remain with the host. */
export class PaymentRouterClient {
    readonly #deployment: PaymentRouterDeployment;
    readonly #provider: Provider;
    constructor(options: { deployment: PaymentRouterDeployment; provider: Provider }) {
        this.#deployment = normalizeDeployment(structuredClone(options.deployment));
        this.#provider = options.provider;
        Object.freeze(this);
    }
    get deployment(): Readonly<PaymentRouterDeployment> {
        return Object.freeze(structuredClone(this.#deployment));
    }
    async preparePayment(input: PrepareRouterPayment): Promise<PreparedTransaction> {
        // NoteOutput instances are immutable; snapshot their ordering and mutable fee data.
        const options = {
            ...input,
            outputs: [...input.outputs],
            ...(input.fee ? { fee: structuredClone(input.fee) } : {}),
        };
        await frame(this.#provider, this.#deployment);
        check(
            options.protocol.context.chainId === this.#deployment.chainId &&
                same(options.protocol.context.protocolAddress, this.#deployment.coreAddress),
            "SDK protocol deployment mismatch"
        );
        check(options.outputs.length >= 2, "pure funding requires at least two Note outputs");

        const amount = uint(
            options.outputs.reduce(
                (sum, output) => sum + uint(output.amount, 128, "output amount", true),
                options.fee?.amount ?? 0n
            ),
            128,
            "total funding amount",
            true
        );
        return options.invisi.prepareTransfer({
            wallet: options.wallet,
            protocol: options.protocol,
            tokenAddress: options.tokenAddress,
            outputs: options.outputs,
            inputs: [],
            funding: { payer: this.#deployment.routerAddress, amount, authorization: "caller" },
            ...(options.fee ? { fee: options.fee } : {}),
            ...(options.deadline !== undefined ? { deadline: options.deadline } : {}),
        });
    }
    async quote(adapter: SwapQuoteAdapter, options: QuoteParameters): Promise<SwapQuote> {
        // Copy financial requirements before any asynchronous reads/transport callbacks.
        const { signal, ...values } = options;
        const pinned = structuredClone(values);
        signal?.throwIfAborted();
        uint(pinned.amountOut, 128, "funding amount", true);
        uint(pinned.maxInput, 256, "ETH budget", true);
        uint(pinned.deadline, 64, "quote deadline");
        check(
            !same(
                pinned.tokenOut,
                pinned.tokenIn && !same(pinned.tokenIn, ZeroAddress)
                    ? pinned.tokenIn
                    : this.#deployment.wethAddress
            ),
            "use the no-swap route for identical tokens"
        );
        const bps = pinned.slippageBps ?? 50;
        check(Number.isInteger(bps) && bps >= 0 && bps <= 10000, "invalid slippageBps");
        const snapshot = await frame(
            this.#provider,
            this.#deployment,
            adapter.channel === "zeroex"
        );
        check(pinned.deadline >= snapshot.now, "quote expired");
        const quote = structuredClone(
            await adapter.quote({
                ...pinned,
                ...snapshot,
                deployment: structuredClone(this.#deployment),
                ...(signal ? { signal } : {}),
            })
        );
        check(
            same(quote.tokenIn ?? ZeroAddress, pinned.tokenIn ?? ZeroAddress),
            "quoted input token changed"
        );
        check(quote.channel === adapter.channel, "quote channel mismatch");
        this.#checkQuote(quote, snapshot);
        check(
            same(quote.tokenOut, pinned.tokenOut) && quote.amountOut === pinned.amountOut,
            "quoted payment amount or token changed"
        );
        check(
            quote.maxInput <= pinned.maxInput && quote.deadline <= pinned.deadline,
            "quote exceeds authorized budget or deadline"
        );
        signal?.throwIfAborted();
        await assertFrame(this.#provider, snapshot);
        // The quoted block may still be canonical after time or the registry has advanced.
        const current = await frame(this.#provider, this.#deployment, quote.channel === "zeroex");
        this.#checkQuote(quote, current);
        signal?.throwIfAborted();
        return Object.freeze(quote);
    }
    #checkQuote(quote: SwapQuote, snapshot: DeploymentFrame): void {
        check(
            quote.chainId === this.#deployment.chainId &&
                same(quote.routerAddress, this.#deployment.routerAddress),
            "quote deployment mismatch"
        );
        uint(quote.amountOut, 128, "quote amount", true);
        uint(quote.maxInput, 256, "quote budget", true);
        uint(quote.estimatedInput, 256, "estimated input");
        uint(quote.deadline, 64, "quote deadline");
        check(quote.estimatedInput <= quote.maxInput, "estimated input exceeds budget");
        check(quote.deadline >= snapshot.now, "quote expired");
        if (quote.channel === "uniswap-v3")
            validateV3Path(
                quote.reversePath,
                quote.tokenIn && !same(quote.tokenIn, ZeroAddress)
                    ? quote.tokenIn
                    : this.#deployment.wethAddress,
                quote.tokenOut
            );
        else if (quote.channel === "zeroex") {
            check(this.#deployment.zeroEx && snapshot.settlerAddress, "0x deployment required");
            check(
                same(quote.settlerAddress, snapshot.settlerAddress),
                "0x Settler changed; refresh the quote"
            );
            const checked = validateZeroExPayload({
                ...quote,
                routerAddress: this.#deployment.routerAddress,
                settlerAddress: snapshot.settlerAddress,
                allowanceHolderAddress: this.#deployment.zeroEx.allowanceHolderAddress,
                now: snapshot.now,
            });
            check(quote.deadline <= checked.nativeDeadline, "quote outlives native guard");
        } else throw new Error("unsupported swap channel");
    }
    /** Inspect the prepared Core call and bind the quote and current payer nonce to the Router intent. */
    async prepareRouterPayment(options: {
        payment: CorePayment;
        payer: Address;
        tokenIn: Address;
        mode: PaymentMode;
        refundRecipient: Address;
        relayer?: Address;
        deadline: bigint;
        amountInMaximum: bigint;
        quote?: SwapQuote;
    }): Promise<RouterPayment> {
        const { payment, ...values } = options;
        const config = structuredClone(values);
        const call = structuredClone(
            "exportTransaction" in payment ? await payment.exportTransaction() : payment
        );
        const snapshot = await frame(
            this.#provider,
            this.#deployment,
            config.quote?.channel === "zeroex"
        );
        const { proof, request } = inspectCorePayment(call, this.#deployment, snapshot.now, true);
        let route = noSwapRoute();
        const quote = config.quote;
        if (quote) {
            this.#checkQuote(quote, snapshot);
            check(
                same(quote.tokenIn ?? ZeroAddress, config.tokenIn) &&
                    same(quote.tokenOut, request.params.token) &&
                    quote.amountOut === request.funding.amount &&
                    config.amountInMaximum === quote.maxInput &&
                    config.deadline <= quote.deadline,
                "intent does not match quote"
            );
            route =
                quote.channel === "uniswap-v3"
                    ? { ...route, channel: RouteChannel.UniswapV3, path: quote.reversePath }
                    : {
                          ...route,
                          channel: RouteChannel.ZeroEx,
                          target: quote.target,
                          data: quote.data,
                      };
        }
        check(
            config.deadline >= snapshot.now && config.deadline <= request.params.deadline,
            "invalid payment deadline"
        );
        const abi = new Interface(paymentRouterAbi);
        const [nonce] = abi.decodeFunctionResult(
            "nonces",
            await this.#provider.call({
                to: this.#deployment.routerAddress,
                data: abi.encodeFunctionData("nonces", [config.payer]),
                blockTag: snapshot.blockNumber,
            })
        );
        const fields: Omit<PaymentIntent, "routeHash" | "coreRequestHash"> = {
            payer: config.payer,
            tokenIn: config.tokenIn,
            mode: config.mode,
            refundRecipient: config.refundRecipient,
            relayer: config.relayer ?? (ZeroAddress as Address),
            amountInMaximum: config.amountInMaximum,
            deadline: config.deadline,
            nonce,
        };
        const intent = buildPaymentIntent(fields, proof, request, route);
        const prepared = {
            routerAddress: this.#deployment.routerAddress,
            wethAddress: this.#deployment.wethAddress,
            proof,
            request,
            route,
            intent,
        };
        buildRouterPayment({
            ...prepared,
            ...(config.mode === PaymentMode.RelayedToken ? { signature: "0x" as const } : {}),
        });
        await assertFrame(this.#provider, snapshot);
        return prepared;
    }
    /** Build the canonical call after optional permit/intent signing by the host. */
    buildRouterTransaction(payment: RouterPayment): TransactionCall {
        check(
            same(payment.routerAddress, this.#deployment.routerAddress) &&
                same(payment.wethAddress, this.#deployment.wethAddress),
            "payment deployment mismatch"
        );
        return buildRouterPayment(structuredClone(payment));
    }
    /** Simulate the complete canonical Router or delegated account transaction from its actual sender. */
    async simulateRouterPayment(
        call: TransactionCall,
        options: { from: Address; authorizationList?: Authorization[] }
    ) {
        const snapshot = await frame(this.#provider, this.#deployment);
        const result = await simulateOuterPayment(
            this.#provider,
            options.from,
            structuredClone(call),
            options.authorizationList
        );
        await assertFrame(this.#provider, snapshot);
        return result;
    }
    /** Legacy native-only Router entry points. */
    async buildPaymentTransaction(options: {
        payment: CorePayment;
        quote: SwapQuote;
        refundRecipient: Address;
    }): Promise<TransactionCall> {
        const quote = structuredClone(options.quote),
            recipient = address(options.refundRecipient, "refund recipient");
        check(
            !same(recipient, this.#deployment.routerAddress),
            "refund recipient must differ from Router"
        );
        check(
            same(quote.tokenIn ?? ZeroAddress, ZeroAddress),
            "legacy native call cannot use a token input"
        );
        const input = options.payment;
        const payment = structuredClone(
            "exportTransaction" in input ? await input.exportTransaction() : input
        );
        const snapshot = await frame(this.#provider, this.#deployment, quote.channel === "zeroex");
        this.#checkQuote(quote, snapshot);
        const { proof, request } = inspectCorePayment(payment, this.#deployment, snapshot.now);
        check(same(request.params.token, quote.tokenOut), "quote output token mismatch");
        check(request.funding.amount === quote.amountOut, "quote funding amount mismatch");
        check(quote.deadline <= request.params.deadline, "quote outlives core proof deadline");
        let data: string;
        if (quote.channel === "uniswap-v3")
            data = routerInterface.encodeFunctionData("pay", [
                proof,
                request,
                quote.reversePath,
                quote.deadline,
                recipient,
            ]);
        else {
            const checked = validateZeroExPayload({
                ...quote,
                routerAddress: this.#deployment.routerAddress,
                settlerAddress: snapshot.settlerAddress!,
                allowanceHolderAddress: this.#deployment.zeroEx!.allowanceHolderAddress,
                now: snapshot.now,
            });
            data = routerInterface.encodeFunctionData("payWithZeroEx", [
                proof,
                request,
                checked.target,
                checked.data,
                quote.deadline,
                recipient,
            ]);
        }
        await assertFrame(this.#provider, snapshot);
        return {
            to: this.#deployment.routerAddress,
            data: data as `0x${string}`,
            value: quote.maxInput,
        };
    }
    /** Simulate the complete payable Router call with the actual submitting wallet address. */
    async simulatePayment(
        input: TransactionCall,
        options: { from: Address }
    ): Promise<RouterSimulation> {
        const call = structuredClone(input),
            from = address(options.from, "sender");
        check(
            same(call.to, this.#deployment.routerAddress),
            "simulation target must be the payment Router"
        );
        uint(call.value, 256, "ETH budget", true);
        const decoded = routerInterface.parseTransaction(call);
        check(
            decoded && (decoded.name === "pay" || decoded.name === "payWithZeroEx"),
            "unsupported Router call"
        );
        const snapshot = await frame(
            this.#provider,
            this.#deployment,
            decoded.name === "payWithZeroEx"
        );
        const a = decoded.args;
        const { request } = inspectCorePayment(
            {
                to: this.#deployment.coreAddress,
                data: coreInterface.encodeFunctionData("transact", [a[0], a[1]]) as `0x${string}`,
                value: 0n,
            },
            this.#deployment,
            snapshot.now
        );
        const deadline: bigint = decoded.name === "pay" ? a[3] : a[4];
        uint(deadline, 64, "swap deadline");
        check(deadline >= snapshot.now, "Router swap expired");
        const recipient = address(decoded.name === "pay" ? a[4] : a[5]);
        check(!same(recipient, this.#deployment.routerAddress), "invalid refund recipient");
        if (decoded.name === "pay")
            validateV3Path(a[2], this.#deployment.wethAddress, request.params.token);
        else
            validateZeroExPayload({
                target: a[2],
                data: a[3],
                routerAddress: this.#deployment.routerAddress,
                tokenOut: request.params.token,
                amountOut: request.funding.amount,
                maxInput: call.value,
                settlerAddress: snapshot.settlerAddress!,
                allowanceHolderAddress: this.#deployment.zeroEx!.allowanceHolderAddress,
                now: snapshot.now,
            });
        const transaction = { ...call, from, blockTag: snapshot.blockNumber };
        const [result, gasEstimate] = await Promise.all([
            this.#provider.call(transaction),
            this.#provider.estimateGas(transaction),
        ]);
        const [ethSpent] = routerInterface.decodeFunctionResult(decoded.name, result);
        check(ethSpent <= call.value, "simulated input exceeds ETH budget");
        await assertFrame(this.#provider, snapshot);
        return { gasEstimate, ethSpent, ethRefunded: call.value - ethSpent };
    }
}
