import { getAddress } from "ethers";
import type { BroadcasterClient, SignedBroadcasterQuote } from "./broadcaster";
import type {
    OperationPlan,
    PreparationRuntime,
    TransferPreparation,
    ShieldPreparation,
    CreateCreditPreparation,
    TopUpCreditPreparation,
    CancelCreditPreparation,
} from "./session/operation-types";
import { TransactionPreparation } from "./session/transaction-preparation";
import { exportBroadcasterIntent } from "./session/operation-protocol";
export type PreparationIntent =
    | { kind: "transfer"; options: TransferPreparation }
    | { kind: "shield"; options: ShieldPreparation }
    | { kind: "create-credit"; options: CreateCreditPreparation }
    | { kind: "top-up-credit"; options: TopUpCreditPreparation }
    | { kind: "cancel-credit"; options: CancelCreditPreparation };
export type BroadcasterFeeSource = "public-funding" | "private-inputs" | "payout";
export interface WithBroadcasterOptions {
    maxFeeAmount: bigint;
    feeSource?: BroadcasterFeeSource;
    maxAttempts?: number;
    /** Optional app-owned permit signing, requested once for the final gross funding amount. */
    fundingPermit?: (request: {
        payer: `0x${string}`;
        amount: bigint;
        tokenAddress: `0x${string}`;
        protocolAddress: `0x${string}`;
    }) => Promise<NonNullable<TransferPreparation["funding"]>["permit"]>;
}
export async function prepareIntent(
    runtime: PreparationRuntime<OperationPlan>,
    intent: PreparationIntent
): Promise<OperationPlan> {
    const preparation = new TransactionPreparation(runtime);
    switch (intent.kind) {
        case "transfer":
            return preparation.prepareTransfer(intent.options);
        case "shield":
            return preparation.prepareShield(intent.options);
        case "create-credit":
            return preparation.prepareCreateCredit(intent.options);
        case "top-up-credit":
            return preparation.prepareTopUpCredit(intent.options);
        case "cancel-credit":
            return preparation.prepareCancelCredit(intent.options);
    }
}
export async function prepareBroadcasterPlan(
    plan: OperationPlan,
    reprepare: (intent: PreparationIntent) => Promise<OperationPlan>,
    client: BroadcasterClient,
    options: WithBroadcasterOptions
): Promise<{ plan: OperationPlan; quote: SignedBroadcasterQuote }> {
    if (!plan.intent) throw new Error("operation has no supported preparation intent");
    const intent = structuredClone(plan.intent);
    intent.options.deadline = plan.deadline;
    const maxFee = options.maxFeeAmount;
    const attempts = options.maxAttempts ?? 4;
    if (typeof maxFee !== "bigint" || maxFee <= 0n || maxFee >= 1n << 128n)
        throw new Error("maxFeeAmount must be a positive uint128");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 16)
        throw new Error("maxAttempts must be 1..16");
    const funding = "funding" in intent.options ? intent.options.funding : undefined;
    let source =
        options.feeSource ??
        (intent.kind === "cancel-credit"
            ? "payout"
            : funding
              ? "public-funding"
              : "private-inputs");
    if (!["public-funding", "private-inputs", "payout"].includes(source))
        throw new Error("unsupported fee source");
    if (
        intent.kind === "cancel-credit"
            ? source !== "payout"
            : source === "payout" || (intent.kind === "shield" && source !== "public-funding")
    )
        throw new Error("fee source is unavailable for this operation");
    if (source === "public-funding" && !funding)
        throw new Error("public funding fee requires an explicit payer");
    const permitCallback = options.fundingPermit;
    let schedule = await client.fee(plan.context.tokenAddress, exportBroadcasterIntent(plan).data);
    let previousAmount = 0n;
    for (let i = 0; i < attempts; i++) {
        const minimum = BigInt(schedule.feeAmount);
        const amount = minimum > previousAmount ? minimum : previousAmount;
        const recipient = getAddress(schedule.feeRecipient) as `0x${string}`;
        if (amount <= 0n || amount > maxFee || amount >= 1n << 128n || BigInt(recipient) === 0n)
            throw new Error("broadcaster fee exceeds user limit or is invalid");
        // Prefer already available private change; never add a payer implicitly.
        if (
            options.feeSource === undefined &&
            funding &&
            plan.inputs.length > 0 &&
            (intent.kind === "transfer" ||
                intent.kind === "create-credit" ||
                intent.kind === "top-up-credit")
        ) {
            const business =
                intent.kind === "transfer"
                    ? intent.options.outputs.reduce(
                          (sum, output) => sum + output.amount,
                          intent.options.withdrawal?.amount ?? 0n
                      )
                    : intent.kind === "create-credit"
                      ? intent.options.amount
                      : intent.options.additionalAmount;
            const change =
                plan.inputs.reduce((sum, input) => sum + input.note.amount, funding.amount) -
                business;
            source = change >= amount ? "private-inputs" : "public-funding";
        }
        if (
            source === "public-funding" &&
            funding?.permit &&
            funding.permit.deadline !== 0n &&
            !permitCallback
        )
            throw new Error(
                "existing permit cannot fund an increased amount; provide fundingPermit for final gross funding or approve separately"
            );
        if (source === "payout" && amount >= plan.credit!.cancel!.amount)
            throw new Error("fee must be less than the cancellation refund");
        const request = structuredClone(intent);
        request.options.fee = { recipient, amount };
        if (funding && "funding" in request.options) {
            const signedFunding = { ...funding };
            if (funding.authorization === "caller") {
                delete signedFunding.sigNonce;
                delete signedFunding.deadline;
            }
            request.options.funding = {
                ...signedFunding,
                amount: funding.amount + (source === "public-funding" ? amount : 0n),
                authorization: "signature",
            };
        }
        const next = await reprepare(request);
        if (source === "private-inputs" && next.inputs.length === 0)
            throw new Error("private-inputs fee requires private funds");
        const recalculated = await client.fee(
            plan.context.tokenAddress,
            exportBroadcasterIntent(next).data
        );
        const required = BigInt(recalculated.feeAmount);
        if (
            getAddress(recalculated.feeRecipient) !== recipient ||
            required <= 0n ||
            required > maxFee
        )
            throw new Error("broadcaster fee exceeds user limit or recipient changed");
        if (amount >= required) {
            let final = next;
            if (permitCallback) {
                if (!funding || !("funding" in request.options))
                    throw new Error("fundingPermit requires public funding");
                const permit = await permitCallback({
                    payer: funding.payer,
                    amount: request.options.funding!.amount,
                    tokenAddress: plan.context.tokenAddress,
                    protocolAddress: plan.context.protocolAddress,
                });
                if (!permit) throw new Error("fundingPermit did not return a permit");
                request.options.funding = { ...request.options.funding!, permit };
                final = await reprepare(request);
                const permitted = await client.fee(
                    plan.context.tokenAddress,
                    exportBroadcasterIntent(final).data
                );
                if (
                    getAddress(permitted.feeRecipient) !== recipient ||
                    BigInt(permitted.feeAmount) > amount
                )
                    throw new Error("permit changed the required fee; prepare again");
            }
            final.intent = structuredClone(intent);
            return {
                plan: final,
                quote: await client.quote(exportBroadcasterIntent(final).data, {
                    chainId: final.context.chainId,
                    protocol: final.context.protocolAddress,
                }),
            };
        }
        previousAmount = amount;
        schedule = recalculated;
    }
    throw new Error("broadcaster fee did not stabilize within the preparation limit");
}
