import { assertCreditPeriodCurrent } from "../transactions/signing/statement";
import { broadcasterRequestHash } from "./index";
import type { SavedOperation } from "../transactions/operation-types";
import { assertCreditUpdatePlan } from "../credit/state";
import { getAddress, randomBytes, hexlify, keccak256 } from "ethers";
import type {
    RevokeCreditPreparation,
    CreateCreditPreparation,
    DrawCreditPreparation,
    OperationPlan,
    PreparationRuntime,
    ShieldPreparation,
    UpdateCreditPreparation,
    TransferPreparation,
} from "../transactions/operation-types";
import { TransactionPreparation } from "../transactions/preparation/transaction-preparation";
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
        case "draw-credit":
            return preparation.prepareDrawCredit(intent.options);
        case "create-credit":
            return preparation.prepareCreateCredit(intent.options);
        case "update-credit":
            return preparation.prepareUpdateCredit(intent.options);
        case "revoke-credit":
            return preparation.prepareRevokeCredit(intent.options);
    }
}
export async function prepareBroadcasterPlan(
    plan: OperationPlan,
    reprepare: (intent: PreparationIntent) => Promise<OperationPlan>,
    client: BroadcasterClient,
    options: BroadcasterQuoteOptions
): Promise<{
    plan: OperationPlan;
    quote: SignedBroadcasterQuote;
    broadcasterBinding: NonNullable<SavedOperation["broadcasterBinding"]>;
}> {
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
    if (!plan.intent) throw new Error("operation has no supported preparation intent");
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
        for (let i = 0; i < attempts; i++) {
            const schedule = await estimate(exportBroadcasterIntent(current).data);
            const minimum = BigInt(schedule.feeAmount),
                amount = minimum > previousAmount ? minimum : previousAmount;
            const recipient = getAddress(schedule.feeRecipient) as `0x${string}`;
            if (amount <= 0n || amount > maxFee || amount >= 1n << 128n || BigInt(recipient) === 0n)
                throw new Error("broadcaster fee exceeds user limit or is invalid");
            const request = structuredClone(intent);
            request.options.fee = { recipient, amount };
            if (
                request.kind === "create-credit" &&
                request.options.initialPayment?.netAmount !== undefined
            )
                request.options.initialPayment.amount =
                    request.options.initialPayment.netAmount + amount;
            current = await reprepare(request);
            await assertCreditUpdatePlan(current);
            if (current.credit?.revocation)
                current.credit.revocationCaller = client.configuration.quoteSigner as `0x${string}`;
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
        for (let i = 0; i < attempts; i++) {
            const quoted = await estimate(exportBroadcasterIntent(current).data);
            const minimum = BigInt(quoted.feeAmount),
                amount = minimum > previous ? minimum : previous;
            const recipient = getAddress(quoted.feeRecipient) as `0x${string}`;
            if (amount <= 0n || amount > maxFee || amount >= 1n << 128n || BigInt(recipient) === 0n)
                throw Error("broadcaster fee exceeds user limit or is invalid");
            if (amount >= gross) throw Error("payout fee leaves no positive withdrawal");
            const request = structuredClone(intent);
            request.options.commitments = plan.inputs.map((input) => input.commitment);
            request.options.withdrawal = { ...intent.options.withdrawal, amount: gross - amount };
            request.options.fee = { recipient, amount };
            current = await reprepare(request);
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
    let schedule = await estimate(exportBroadcasterIntent(plan).data);
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
        if (
            source === "public-funding" &&
            funding?.permit &&
            funding.permit.deadline !== 0n &&
            !permitCallback
        )
            throw new Error(
                "existing permit cannot fund an increased amount; provide fundingPermit for final gross funding or approve separately"
            );
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
