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
    buildAccountPaymentDraft,
    buildRouterPaymentDraft,
    finalizeRouterPayment,
    estimateRouterPaymentGas,
    unsignedDelegation,
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

async function prepare(
    host: HostPayment,
    mode: PaymentMode,
    relayer?: Address,
    feeAmount?: bigint
) {
    const prepared = await host.client.preparePayment({
        ...host.preparation,
        ...(feeAmount !== undefined
            ? { fee: { recipient: host.preparation.fee!.recipient, amount: feeAmount } }
            : {}),
    });
    const amountOut = prepared.preview().funding.amount; // outputs + Core fee
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
    const payment = await host.client.prepareRouterPaymentDraft({
        payment: prepared,
        payer: host.payer,
        tokenIn: host.tokenIn,
        mode,
        refundRecipient: host.refundRecipient,
        deadline: quote && quote.deadline < host.deadline ? quote.deadline : host.deadline,
        amountInMaximum: quote?.maxInput ?? host.maxInput,
        ...(relayer ? { relayer } : {}),
        ...(quote ? { quote } : {}),
    });
    const coreCalldata = (await prepared.exportBroadcasterIntent()).data;
    return { prepared, payment, coreCalldata };
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
    const draft = await prepare(host, PaymentMode.DirectToken);
    const ready = await draft.prepared.prove();
    const payment = finalizeRouterPayment(draft.payment, await ready.exportTransaction());
    await ensureAllowance(host, payment.intent.amountInMaximum);
    const outer = host.client.buildRouterTransaction(payment);
    const simulation = await host.client.simulateRouterPayment(outer, { from: host.payer });
    // Host wallet sends outer from payer, paying gas; no Broadcaster is involved.
    return { outer, simulation };
}

export interface RelayBudget {
    relay: PaymentRouterRelayClient;
    approvedCoreFeeAmount: bigint;
    maxFeeAmount: bigint;
    zeroExGasUnits?: number; // Independently trusted service policy; never a client override on the service.
}
async function approveDraftFee(budget: RelayBudget, input: RouterRelayInput) {
    const estimate = await budget.relay.estimateRouterFee(input);
    if (
        budget.approvedCoreFeeAmount < BigInt(estimate.feeAmount) ||
        budget.approvedCoreFeeAmount > budget.maxFeeAmount
    )
        throw new Error("Host-approved fee must cover the estimate and fit the fee cap");
    return estimate;
}
/** Formal fee quote precedes proving and wallet signing. Returns a reviewed submission, never broadcasts. */
export async function prepareRelayedToken(
    host: TokenHost,
    signer: Signer,
    relayer: Address,
    budget: RelayBudget
) {
    if (!host.preparation.fee) throw new Error("Trusted fee recipient required");
    const provisional = await prepare(host, PaymentMode.RelayedToken, relayer);
    await approveDraftFee(budget, {
        coreCalldata: provisional.coreCalldata,
        outer: buildRouterPaymentDraft(provisional.payment),
    });
    // Rebuild the unsigned Core request and exact-output route with the approved final fee.
    const draft = await prepare(
        host,
        PaymentMode.RelayedToken,
        relayer,
        budget.approvedCoreFeeAmount
    );
    const baseline = draft.prepared.estimateGas();
    if (!baseline.available) throw new Error("Core preview unavailable");
    const localGas = estimateRouterPaymentGas(draft.payment, baseline.gasUnits, {
        ...(budget.zeroExGasUnits !== undefined ? { zeroExGasUnits: budget.zeroExGasUnits } : {}),
    });
    const quotedInput = {
        coreCalldata: draft.coreCalldata,
        outer: buildRouterPaymentDraft(draft.payment),
    };
    const signedQuote = await budget.relay.getQuote(quotedInput);
    const ready = await draft.prepared.prove();
    const coreCall = await ready.exportTransaction();
    const payment = finalizeRouterPayment(draft.payment, coreCall);
    await ensureAllowance(host, payment.intent.amountInMaximum);
    payment.signature = await signPaymentIntent(
        signer,
        host.client.deployment.chainId,
        host.client.deployment.routerAddress,
        payment.intent
    );
    const input: RouterRelayInput = {
        coreCalldata: coreCall.data,
        outer: host.client.buildRouterTransaction(payment),
    };
    await host.client.simulateRouterPayment(input.outer, { from: relayer });
    // Persist input + signedQuote. Host explicitly calls budget.relay.submitTransaction(input,signedQuote).
    return { input, signedQuote, localGas };
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

/** Native action and EOA authorization nonces are pinned in the unsigned quote; sign only after proof. */
export async function prepareRelayedNative(
    host: NativeHost,
    signer: Signer,
    relayer: Address,
    budget: RelayBudget
) {
    if (host.tokenIn.toLowerCase() !== ZeroAddress || !host.preparation.fee)
        throw new Error("Native input and trusted fee recipient required");
    const makeDraft = async (feeAmount?: bigint) => {
        const draft = await prepare(host, PaymentMode.SponsoredNative, relayer, feeAmount);
        const account = await prepareNativeAccountPayment(
            host.provider,
            {
                chainId: host.client.deployment.chainId,
                implementation: host.implementation,
                payer: host.payer,
                routerCall: buildRouterPaymentDraft(draft.payment),
                deadline: draft.payment.intent.deadline,
                relayer,
            },
            {
                implementationCodeHash: host.implementationCodeHash,
                ...(host.undelegatedNonce !== undefined
                    ? { undelegatedNonce: host.undelegatedNonce }
                    : {}),
            }
        );
        const authorizationList = account.authorizationRequest
            ? [unsignedDelegation(account.authorizationRequest)]
            : [];
        const input: RouterRelayInput = {
            coreCalldata: draft.coreCalldata,
            outer: buildAccountPaymentDraft(account.payment),
            authorizationList,
        };
        return { draft, account, input };
    };
    const provisional = await makeDraft();
    await approveDraftFee(budget, provisional.input);
    const { draft, account, input: quotedInput } = await makeDraft(budget.approvedCoreFeeAmount);
    const baseline = draft.prepared.estimateGas();
    if (!baseline.available) throw new Error("Core preview unavailable");
    const localGas = estimateRouterPaymentGas(draft.payment, baseline.gasUnits, {
        authorizationCount: quotedInput.authorizationList?.length ?? 0,
        ...(budget.zeroExGasUnits !== undefined ? { zeroExGasUnits: budget.zeroExGasUnits } : {}),
    });
    const signedQuote = await budget.relay.getQuote(quotedInput);
    const ready = await draft.prepared.prove(),
        coreCall = await ready.exportTransaction();
    const payment = finalizeRouterPayment(draft.payment, coreCall);
    const actualAccount = {
        ...account.payment,
        routerCall: host.client.buildRouterTransaction(payment),
    };
    const authorizationList: Authorization[] = [];
    if (account.authorizationRequest) {
        const authorization = await host.signDelegation(account.authorizationRequest);
        validateDelegation(
            authorization,
            host.payer,
            host.implementation,
            host.client.deployment.chainId,
            BigInt(account.authorizationRequest.nonce)
        );
        authorizationList.push(authorization);
    }
    const outer = buildAccountPayment(
        actualAccount,
        await signNativePayment(signer, actualAccount)
    );
    await host.client.simulateRouterPayment(outer, { from: relayer, authorizationList });
    const input: RouterRelayInput = { coreCalldata: coreCall.data, outer, authorizationList };
    // Persist input + signedQuote; host explicitly submits. Matching installed delegation needs no tuple.
    return { input, signedQuote, localGas };
}
