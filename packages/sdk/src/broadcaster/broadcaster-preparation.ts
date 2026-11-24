import { assertCreditPeriodCurrent } from "../transactions/signing/statement";
import {
    broadcasterRequestHash,
    broadcasterTransactInterface,
    decodeBroadcasterIntent,
    BroadcasterRpcError,
} from "./index";
import type { SavedOperation } from "../transactions/operation-types";
import { assertCreditUpdatePlan } from "../credit/state";
import { getAddress, randomBytes, hexlify, keccak256 } from "ethers";
import type {
    RevokeCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    ShieldPreparation,
    UpdateCreditPreparation,
    TransferPreparation,
} from "../transactions/operation-types";
import { repricePlan, needsReprepare } from "./reprice";
import type { BroadcasterClient, SignedBroadcasterQuote } from "./index";
import { exportBroadcasterIntent } from "./intent";
export type PreparationIntent =
    | { kind: "transfer"; options: TransferPreparation }
    | { kind: "shield"; options: ShieldPreparation }
    | { kind: "create-credit"; options: CreateCreditPreparation }
    | { kind: "draw-credit"; options: DrawCreditPreparation }
    | { kind: "update-credit"; options: UpdateCreditPreparation }
    | { kind: "revoke-credit"; options: RevokeCreditPreparation };
export type BroadcasterFeeSource = "public-funding" | "private-inputs" | "payout";
export interface BroadcasterQuoteOptions {
    maxFeeAmount: bigint;
    schedule?: { publishAfter: bigint; executeBefore?: bigint };
    /** Persist the scoped secret before submission; a rejected write aborts preparation. */
    persistSchedule?: (handle: import("./index").BroadcasterScheduleHandle) => Promise<void>;
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
/** Price the paid execution features without changing the prepared business intent.
 * Estimates accept unsigned calldata; the real fee is still selected from the
 * response and checked against the exact repriced intent before obtaining a quote.
 */
function initialOrdinaryEstimateData(
    plan: OperationPlan,
    feeRecipient: string,
    signatureFunding: boolean
): string {
    const data = exportBroadcasterIntent(plan).data;
    const decoded = decodeBroadcasterIntent(data);
    if (decoded.method !== "transact" && decoded.method !== "shield") return data;
    const params = {
        ...decoded.request.params.toObject(),
        feeRecipient,
        feeAmount: 1n,
    };
    const funding = { ...decoded.request.funding.toObject() };
    if (signatureFunding && funding.amount > 0n && funding.deadline === 0n)
        funding.deadline = plan.deadline;
    const args =
        decoded.method === "transact"
            ? [decoded.proof, { params, deliveries: decoded.request.deliveries, funding }]
            : [params, decoded.args[1], decoded.request.deliveries, funding];
    return broadcasterTransactInterface.encodeFunctionData(decoded.fragment, args);
}

type QuotedPlan = {
    plan: OperationPlan;
    quote: SignedBroadcasterQuote;
    broadcasterBinding: NonNullable<SavedOperation["broadcasterBinding"]>;
};
export function prepareBroadcasterPlan(
    plan: OperationPlan,
    client: BroadcasterClient,
    options: BroadcasterQuoteOptions
): Promise<QuotedPlan>;
/** @deprecated The legacy builder is accepted for compatibility. Quotes use only prepared inputs. */
export function prepareBroadcasterPlan(
    plan: OperationPlan,
    legacyBuilder: (intent: PreparationIntent) => Promise<OperationPlan>,
    client: BroadcasterClient,
    options: BroadcasterQuoteOptions
): Promise<QuotedPlan>;
export async function prepareBroadcasterPlan(
    plan: OperationPlan,
    clientOrBuilder: BroadcasterClient | ((intent: PreparationIntent) => Promise<OperationPlan>),
    clientOrOptions: BroadcasterClient | BroadcasterQuoteOptions,
    legacyOptions?: BroadcasterQuoteOptions
): Promise<QuotedPlan> {
    const client = (
        typeof clientOrBuilder === "function" ? clientOrOptions : clientOrBuilder
    ) as BroadcasterClient;
    const options = legacyOptions ?? (clientOrOptions as BroadcasterQuoteOptions);
    if (plan.fundingMode === "caller")
        needsReprepare("Prepare again with signature funding to select its nonce and deadline");
    if (options.schedule) assertCreditPeriodCurrent(plan, options.schedule.publishAfter);
    const capabilities = options.schedule
        ? await client.scheduling({
              chainId: plan.context.chainId,
              protocol: plan.context.protocolAddress,
          })
        : undefined;
    const end = options.schedule
        ? (options.schedule.executeBefore ??
          options.schedule.publishAfter + BigInt(capabilities!.defaultExecutionWindowSeconds))
        : undefined;
    if (
        options.schedule &&
        (!capabilities!.enabled ||
            options.schedule.publishAfter <= BigInt(Math.floor(Date.now() / 1000)) ||
            options.schedule.publishAfter >
                BigInt(Math.floor(Date.now() / 1000)) + BigInt(capabilities!.maxDelaySeconds) ||
            end! <= options.schedule.publishAfter ||
            end! - options.schedule.publishAfter >
                BigInt(capabilities!.maxExecutionWindowSeconds) ||
            plan.deadline < end! + BigInt(capabilities!.minDeadlineSlackSeconds))
    )
        throw Error("Schedule unavailable or exceeds broadcaster/authorization bounds");
    const cancellation = options.schedule ? hexlify(randomBytes(32)) : undefined;
    const requestedSchedule = options.schedule
        ? {
              publishAfter: options.schedule.publishAfter.toString(),
              executeBefore: end!.toString(),
              cancelTokenHash: keccak256(cancellation!),
          }
        : undefined;
    if (requestedSchedule && !options.persistSchedule)
        throw Error("Scheduled operations require persistSchedule");
    const handle = requestedSchedule
        ? {
              endpoint: client.configuration.endpoint,
              chainId: plan.context.chainId.toString(),
              protocol: plan.context.protocolAddress,
              cancelToken: cancellation!,
              publishAfter: requestedSchedule.publishAfter,
              executeBefore: requestedSchedule.executeBefore,
          }
        : undefined;
    const estimate = (data: string) =>
        client.estimateQuote(requestedSchedule ? { data, schedule: requestedSchedule } : data);
    const finalize = async (final: OperationPlan) => {
        if (options.schedule) {
            assertCreditPeriodCurrent(final, options.schedule.publishAfter);
            assertCreditPeriodCurrent(final, end! - 1n);
            for (const deadline of [final.funding.deadline, final.funding.permit?.deadline])
                if (deadline && deadline < end!)
                    throw Error("Schedule exceeds the funding or permit deadline");
        }
        const data = exportBroadcasterIntent(final).data;
        const quote = await client.getQuote(
            requestedSchedule ? { data, schedule: requestedSchedule } : data,
            {
                chainId: final.context.chainId,
                protocol: final.context.protocolAddress,
            }
        );
        const { context: _context, ...wireQuote } = quote;
        const scopedHandle = handle ? { ...handle, quote: structuredClone(wireQuote) } : undefined;
        if (scopedHandle) await options.persistSchedule!(structuredClone(scopedHandle));
        return {
            plan: final,
            quote,
            broadcasterBinding: {
                configuration: { ...client.configuration },
                intentHash: broadcasterRequestHash(data),
                ...(scopedHandle ? { scheduleHandle: scopedHandle } : {}),
            },
        };
    };
    if (!plan.intent || plan.intent.kind !== plan.kind)
        needsReprepare("Prepare again with a complete business intent");
    await assertCreditUpdatePlan(plan);
    const intent = structuredClone(plan.intent);
    intent.options.deadline = plan.deadline;
    const maxFee = options.maxFeeAmount;
    const attempts = options.maxAttempts ?? 4;
    if (typeof maxFee !== "bigint" || maxFee <= 0n || maxFee >= 1n << 128n)
        throw new Error("maxFeeAmount must be a positive uint128");
    if (!Number.isInteger(attempts) || attempts < 1 || attempts > 16)
        throw new Error("maxAttempts must be 1..16");
    if (intent.kind !== "transfer" && intent.kind !== "shield") {
        if (options.feeSource || options.fundingPermit)
            throw new Error("Credit fees use the owner allowance or gross draw deduction");
        let current = plan;
        let previousAmount = 0n;
        let schedule = await estimate(exportBroadcasterIntent(current).data);
        for (let i = 0; i < attempts; i++) {
            const minimum = BigInt(schedule.feeAmount),
                amount = minimum > previousAmount ? minimum : previousAmount;
            const recipient = getAddress(schedule.feeRecipient) as `0x${string}`;
            if (amount <= 0n || amount > maxFee || amount >= 1n << 128n || BigInt(recipient) === 0n)
                throw new Error("broadcaster fee exceeds user limit or is invalid");
            current = await repricePlan(plan, recipient, amount);
            await assertCreditUpdatePlan(current);
            if (current.credit?.revocation) {
                if (
                    intent.kind === "revoke-credit" &&
                    intent.options.caller &&
                    getAddress(intent.options.caller) !== client.configuration.quoteSigner
                )
                    needsReprepare("Prepare revocation for the broadcaster caller");
                current.credit.revocationCaller = client.configuration.quoteSigner as `0x${string}`;
            }
            const data = exportBroadcasterIntent(current).data;
            const recalculated = await estimate(data);
            if (
                getAddress(recalculated.feeRecipient) !== recipient ||
                BigInt(recalculated.feeAmount) <= 0n ||
                BigInt(recalculated.feeAmount) > maxFee
            )
                throw new Error("broadcaster fee exceeds user limit or recipient changed");
            if (amount >= BigInt(recalculated.feeAmount)) {
                current.intent = structuredClone(intent);
                return finalize(current);
            }
            previousAmount = amount;
            schedule = recalculated;
        }
        throw new Error("broadcaster fee did not stabilize within the preparation limit");
    }
    if (options.feeSource === "payout") {
        if (
            intent.kind !== "transfer" ||
            plan.kind !== "transfer" ||
            !plan.inputs.length ||
            plan.outputs.length ||
            plan.params?.noteCommitments.length ||
            (plan.funding.amount ?? 0n) !== 0n ||
            !intent.options.withdrawal ||
            BigInt(intent.options.withdrawal.to) === 0n ||
            options.fundingPermit
        )
            throw Error("payout fee requires a pure unfunded withdrawal");
        const gross = plan.inputs.reduce((sum, input) => sum + input.note.amount, 0n);
        if (gross !== plan.params!.withdrawalAmount + (plan.params!.feeAmount ?? 0n))
            throw Error("payout requires the full selected note sum");
        let current = plan,
            previous = 0n;
        let quoted = await estimate(exportBroadcasterIntent(current).data);
        for (let i = 0; i < attempts; i++) {
            const minimum = BigInt(quoted.feeAmount),
                amount = minimum > previous ? minimum : previous;
            const recipient = getAddress(quoted.feeRecipient) as `0x${string}`;
            if (amount <= 0n || amount > maxFee || amount >= 1n << 128n || BigInt(recipient) === 0n)
                throw Error("broadcaster fee exceeds user limit or is invalid");
            if (amount >= gross) throw Error("payout fee leaves no positive withdrawal");
            current = await repricePlan(plan, recipient, amount, "payout");
            if (
                current.outputs.length ||
                current.inputs.length !== plan.inputs.length ||
                current.inputs.some(
                    (input, i) => input.commitment !== plan.inputs[i]!.commitment
                ) ||
                (current.funding.amount ?? 0n) !== 0n
            )
                throw Error("payout repricing changed selected inputs or authorization");
            const required = await estimate(exportBroadcasterIntent(current).data);
            if (
                getAddress(required.feeRecipient) !== recipient ||
                BigInt(required.feeAmount) <= 0n ||
                BigInt(required.feeAmount) > maxFee
            )
                throw Error("broadcaster fee exceeds user limit or recipient changed");
            if (amount >= BigInt(required.feeAmount)) {
                current.intent = structuredClone(intent);
                return finalize(current);
            }
            previous = amount;
            quoted = required;
        }
        throw Error("broadcaster fee did not stabilize within the preparation limit");
    }
    const funding = "funding" in intent.options ? intent.options.funding : undefined;
    let source = options.feeSource ?? (funding ? "public-funding" : "private-inputs");
    if (!["public-funding", "private-inputs"].includes(source))
        throw new Error("unsupported fee source");
    if (intent.kind === "shield" && source !== "public-funding")
        throw new Error("fee source is unavailable for this operation");
    if (source === "public-funding" && !funding)
        throw new Error("public funding fee requires an explicit payer");
    const permitCallback = options.fundingPermit;
    let schedule = await estimate(
        initialOrdinaryEstimateData(plan, client.configuration.feeRecipient, Boolean(funding))
    );
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
            intent.kind === "transfer"
        ) {
            const business = intent.options.outputs.reduce(
                (sum, output) => sum + output.amount,
                intent.options.withdrawal?.amount ?? 0n
            );
            const change =
                plan.inputs.reduce((sum, input) => sum + input.note.amount, funding.amount) -
                business;
            source = change >= amount ? "private-inputs" : "public-funding";
        }
        const next = await repricePlan(plan, recipient, amount, source);
        if (
            plan.funding.permit?.deadline &&
            plan.funding.amount !== next.funding.amount &&
            !permitCallback
        )
            throw new Error(
                "existing permit cannot fund a changed amount; provide fundingPermit for final gross funding or approve separately"
            );
        if (source === "private-inputs" && next.inputs.length === 0)
            throw new Error("private-inputs fee requires private funds");
        if (
            intent.kind === "shield" &&
            !requestedSchedule &&
            !permitCallback &&
            !plan.funding.permit?.deadline
        ) {
            // getQuote prices and signs this exact repriced intent. A successful
            // verified quote supersedes a separate unsigned final estimate.
            next.intent = structuredClone(intent);
            try {
                return await finalize(next);
            } catch (cause) {
                // Legacy quote endpoints use a generic business-refusal code.
                // This read-only failure permits one fresh estimate per bounded
                // iteration; retry only if the price actually increased.
                if (
                    !(cause instanceof BroadcasterRpcError) ||
                    cause.code !== -32000 ||
                    i + 1 >= attempts
                )
                    throw cause;
                const refreshed = await estimate(exportBroadcasterIntent(next).data);
                const required = BigInt(refreshed.feeAmount);
                if (getAddress(refreshed.feeRecipient) !== recipient || required > maxFee)
                    throw Error("broadcaster fee exceeds user limit or recipient changed");
                if (required <= amount) throw cause;
                previousAmount = amount;
                schedule = refreshed;
                continue;
            }
        }
        const recalculated = await estimate(exportBroadcasterIntent(next).data);
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
                if (!funding) throw new Error("fundingPermit requires public funding");
                const permit = await permitCallback({
                    payer: funding.payer,
                    amount: next.funding.amount!,
                    tokenAddress: plan.context.tokenAddress,
                    protocolAddress: plan.context.protocolAddress,
                });
                if (!permit) throw new Error("fundingPermit did not return a permit");
                final = await repricePlan(next, recipient, amount, source, permit);
                const permitted = await estimate(exportBroadcasterIntent(final).data);
                if (
                    getAddress(permitted.feeRecipient) !== recipient ||
                    BigInt(permitted.feeAmount) > amount
                )
                    throw new Error("permit changed the required fee; prepare again");
            }
            final.intent = structuredClone(intent);
            return finalize(final);
        }
        previousAmount = amount;
        schedule = recalculated;
    }
    throw new Error("broadcaster fee did not stabilize within the preparation limit");
}
