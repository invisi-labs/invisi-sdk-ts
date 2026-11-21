// Unreleased source-workspace example. Import from a host application; no top-level execution.
// Host owns keys, allowance transactions, budgets, persistence and explicit relay submission.
import { ZeroAddress, type Authorization, type Provider, type Signer } from "ethers";
import type { TransactionCall } from "@invisi-labs/protocol";
import type { Address, Hex } from "@invisi-labs/protocol/contracts";
import {
    PaymentMode,
    PaymentRouterClient,
    PaymentRouterRelayClient,
    buildAccountPayment,
    inputAllowance,
    inputApproval,
    prepareNativeAccountPayment,
    signNativePayment,
    signPaymentIntent,
    validateDelegation,
    type PrepareRouterPayment,
    type RouterRelayInput,
    type SwapQuoteAdapter,
} from "@invisi-labs/payment-router";

export interface HostPayment {
    client: PaymentRouterClient;
    provider: Provider;
    // Contains Invisi with a real prover, public wallet, Protocol and explicit Note outputs.
    // For relay, fee must name the trusted Broadcaster recipient and an approved provisional amount.
    preparation: PrepareRouterPayment;
    payer: Address;
    refundRecipient: Address;
    tokenIn: Address;
    maxInput: bigint;
    // Must fit within preparation.deadline and any route/permit/account deadlines.
    deadline: bigint;
    // Required for different-token swaps; omitted only for same-token/native-to-WETH funding.
    adapter?: SwapQuoteAdapter;
}

export interface TokenHost extends HostPayment {
    // Explicit host callback: review/send approval from payer and wait for its receipt.
    // Token-specific zero-reset rules and alternative ERC-2612 permit flows are host policy.
    confirmApproval: (approval: TransactionCall) => Promise<void>;
}

async function prepare(host: HostPayment, mode: PaymentMode, relayer?: Address) {
    const prepared = await host.client.preparePayment(host.preparation);
    const amountOut = prepared.preview().funding.amount; // outputs + Core fee
    const ready = await prepared.prove(); // No private inputs; use the real configured prover.
    const effectiveInput =
        host.tokenIn.toLowerCase() === ZeroAddress
            ? host.client.deployment.wethAddress
            : host.tokenIn;
    const sameToken = effectiveInput.toLowerCase() === host.preparation.tokenAddress.toLowerCase();
    if (!sameToken && !host.adapter) throw new Error("A swap adapter is required");
    const quote = sameToken
        ? undefined
        : await host.client.quote(host.adapter!, {
              tokenIn: host.tokenIn,
              tokenOut: host.preparation.tokenAddress,
              amountOut,
              maxInput: host.maxInput,
              deadline: host.deadline,
          });
    const payment = await host.client.prepareRouterPayment({
        payment: ready,
        payer: host.payer,
        tokenIn: host.tokenIn,
        mode,
        refundRecipient: host.refundRecipient,
        deadline: quote && quote.deadline < host.deadline ? quote.deadline : host.deadline,
        amountInMaximum: quote?.maxInput ?? host.maxInput,
        ...(relayer ? { relayer } : {}),
        ...(quote ? { quote } : {}),
    });
    return { ready, payment };
}

async function ensureAllowance(host: TokenHost, amount: bigint) {
    if (host.tokenIn.toLowerCase() === ZeroAddress) throw new Error("ERC20 input required");
    const router = host.client.deployment.routerAddress;
    if ((await inputAllowance(host.provider, host.tokenIn, host.payer, router)) < amount) {
        await host.confirmApproval(inputApproval(host.tokenIn, router, amount));
        if ((await inputAllowance(host.provider, host.tokenIn, host.payer, router)) < amount)
            throw new Error("Host approval has not established sufficient Router allowance");
    }
}

/** Real proof + allowance + simulation, then return the unsigned call for host review/send. */
export async function prepareSelfToken(host: TokenHost) {
    const { payment } = await prepare(host, PaymentMode.DirectToken);
    await ensureAllowance(host, payment.intent.amountInMaximum);
    const outer = host.client.buildRouterTransaction(payment);
    const simulation = await host.client.simulateRouterPayment(outer, { from: host.payer });
    // Host wallet sends outer from payer, paying gas; no Broadcaster is involved.
    return { outer, simulation };
}

/** Fixed relayer is the actual Broadcaster sender, obtained and independently checked by the host. */
export async function prepareRelayedToken(host: TokenHost, signer: Signer, relayer: Address) {
    const { ready, payment } = await prepare(host, PaymentMode.RelayedToken, relayer);
    await ensureAllowance(host, payment.intent.amountInMaximum);
    payment.signature = await signPaymentIntent(
        signer,
        host.client.deployment.chainId,
        host.client.deployment.routerAddress,
        payment.intent
    );
    const outer = host.client.buildRouterTransaction(payment);
    await host.client.simulateRouterPayment(outer, { from: relayer });
    const input: RouterRelayInput = { coreCalldata: (await ready.exportTransaction()).data, outer };
    return input;
}

export interface NativeHost extends HostPayment {
    implementation: Address;
    implementationCodeHash: Hex;
    // Persisted action nonce for an undelegated account; 0n only for a known fresh account.
    // Revoking delegation does not reset it. Existing delegation reads its own action nonce.
    undelegatedNonce?: bigint;
    // Host wallet's EIP-7702 integration; this is a host callback, not an SDK wallet method.
    signDelegation: (
        request: NonNullable<
            Awaited<ReturnType<typeof prepareNativeAccountPayment>>["authorizationRequest"]
        >
    ) => Promise<Authorization>;
}

/** Native principal comes from payer balance; the Broadcaster outer value remains zero. */
export async function prepareRelayedNative(host: NativeHost, signer: Signer, relayer: Address) {
    if (host.tokenIn.toLowerCase() !== ZeroAddress) throw new Error("Native input required");
    const { ready, payment } = await prepare(host, PaymentMode.SponsoredNative, relayer);
    const account = await prepareNativeAccountPayment(
        host.provider,
        {
            chainId: host.client.deployment.chainId,
            implementation: host.implementation,
            payer: host.payer,
            routerCall: host.client.buildRouterTransaction(payment),
            deadline: payment.intent.deadline,
            relayer,
        },
        {
            implementationCodeHash: host.implementationCodeHash,
            ...(host.undelegatedNonce !== undefined
                ? { undelegatedNonce: host.undelegatedNonce }
                : {}),
        }
    );
    const authorizationList: Authorization[] = [];
    if (account.delegationNeeded) {
        const request = account.authorizationRequest!;
        const authorization = await host.signDelegation(request);
        validateDelegation(
            authorization,
            host.payer,
            host.implementation,
            host.client.deployment.chainId,
            BigInt(request.nonce)
        );
        authorizationList.push(authorization);
    }
    const signature = await signNativePayment(signer, account.payment);
    const outer = buildAccountPayment(account.payment, signature);
    await host.client.simulateRouterPayment(outer, { from: relayer, authorizationList });
    // Matching installed delegation needs no authorization tuple. Delegation can persist on revert.
    const input: RouterRelayInput = {
        coreCalldata: (await ready.exportTransaction()).data,
        outer,
        ...(authorizationList.length ? { authorizationList } : {}),
    };
    return input;
}

/** Does not submit. Call again only with a rebuilt, approved, fully signed payment if needed. */
export async function reviewRelay(
    relay: PaymentRouterRelayClient,
    input: RouterRelayInput,
    coreFeeAmount: bigint,
    maxFeeAmount: bigint
) {
    if (coreFeeAmount > maxFeeAmount) throw new Error("Core fee exceeds host limit");
    const estimate = await relay.estimateQuote(input);
    if (BigInt(estimate.feeAmount) > maxFeeAmount) throw new Error("Relay fee exceeds host limit");
    if (BigInt(estimate.feeAmount) > coreFeeAmount)
        return { rebuildRequired: true as const, estimate };
    const signedQuote = await relay.getQuote(input); // Verifies exact Core fee and envelope binding.
    if (BigInt(signedQuote.quote.feeAmount) > maxFeeAmount)
        throw new Error("Quoted Core fee exceeds host limit");
    // Persist input + signedQuote before explicit relay.submitTransaction(input, signedQuote).
    // Save returned id; poll broadcaster_getTransactionStatus with params:[{id}] using host RPC.
    // An uncertain acknowledgement must recover the frozen request, not prepare a fresh payment.
    return { rebuildRequired: false as const, estimate, input, signedQuote };
}
