import type { Hex, InputSource } from "@invisi-labs/protocol/contracts";

import { creditPeriods, type AuthorizedStatement, type WalletOperation } from "@invisi-labs/core";
import {
    WitnessBuilder,
    buildCancelCreditCalldata,
    buildCreateCreditCalldata,
    buildCreditDrawCalldata,
    buildShieldCalldata,
    buildTopUpCreditCalldata,
    buildTransactCalldata,
    cancelCreditPublicInputs,
    createCreditPublicInputs,
    creditDrawPublicInputs,
    encodeAggregateFundingTypedData,
    encodeCreateCreditFundingTypedData,
    encodeShieldFundingTypedData,
    encodeTopUpCreditFundingTypedData,
    encodeTransactFundingTypedData,
    topUpCreditPublicInputs,
    transactUserPublicInputs,
    type TokenProtocol,
    type TransactionCall,
} from "@invisi-labs/protocol";
import type { ProofBundle, ProofStatement, ProvingRequest } from "@invisi-labs/prover";

import type { OperationPlan, SavedOperation } from "./operation-types";
import { creditReservationKey } from "./state";

export function requiresAuthorization(plan: OperationPlan): boolean {
    if (plan.kind === "sweep") {
        if (
            plan.credit ||
            !plan.inputs.length ||
            plan.outputs.length ||
            !plan.params ||
            plan.params.outputCommitments.length ||
            (plan.funding.amount ?? 0n) !== 0n ||
            BigInt(plan.params.withdrawalAddress) !== BigInt(plan.scope.walletIdentity) ||
            plan.params.withdrawalAmount !==
                plan.inputs.reduce((sum, input) => sum + input.note.amount, 0n) ||
            plan.inputs.some((input) => input.note.walletIdentity !== plan.scope.walletIdentity)
        )
            throw new Error("invalid owner-only sweep plan");
        return false;
    }
    return !!plan.credit || plan.inputs.length > 0;
}

export function inputFacts(
    plan: OperationPlan
): Array<{ key: string; reservationKey: string; nullifier: Hex; kind: "notes" | "credits" }> {
    const credit = plan.credit;
    const noteNullifiers = plan.params?.nullifiers ?? credit?.creation?.nullifiers ?? [];
    let creditNullifiers: readonly Hex[] = [];

    if (credit?.draw) {
        creditNullifiers = credit.draw.nullifiers;
    } else if (credit?.topUp) {
        creditNullifiers = [credit.topUp.creditNullifier];
    } else if (credit?.cancel) {
        creditNullifiers = [credit.cancel.nullifier];
    }

    if (
        noteNullifiers.length !== plan.inputs.length ||
        creditNullifiers.length !== (credit?.inputs.length ?? 0)
    ) {
        throw new Error("operation input statement count mismatch");
    }

    return [
        ...plan.inputs.map((input, index) => ({
            key: input.commitment,
            reservationKey: input.commitment,
            nullifier: noteNullifiers[index]!,
            kind: "notes" as const,
        })),
        ...(credit?.inputs ?? []).map((input, index) => ({
            key: input.commitment + ":" + input.role,
            reservationKey: creditReservationKey(input.commitment),
            nullifier: creditNullifiers[index]!,
            kind: "credits" as const,
        })),
    ];
}

export function operationSources(plan: OperationPlan): readonly InputSource[] {
    const noteSources = plan.params?.sources;
    if (noteSources != null) return noteSources;

    const credit = plan.credit;
    if (credit?.topUp) {
        return [...credit.topUp.creation.sources, credit.topUp.creditSource];
    }
    if (credit?.creation) return credit.creation.sources;
    if (credit?.draw) return credit.draw.sources;
    if (credit?.cancel) return [credit.cancel.source];
    return [];
}

export function statement(plan: OperationPlan): ProofStatement {
    if (!plan.statement) throw new Error("operation has no proof statement");

    const credit = plan.credit;
    let words: Hex[];
    if (credit?.topUp) {
        words = topUpCreditPublicInputs(
            plan.context,
            credit.topUp,
            credit.deliveries,
            plan.funding
        );
    } else if (credit?.creation) {
        words = createCreditPublicInputs(
            plan.context,
            credit.creation,
            credit.deliveries,
            plan.funding
        );
    } else if (credit?.draw) {
        words = creditDrawPublicInputs(plan.context, credit.draw, credit.deliveries);
    } else if (credit?.cancel) {
        words = cancelCreditPublicInputs(plan.context, credit.cancel);
    } else {
        words = transactUserPublicInputs(
            plan.context,
            plan.params!,
            plan.outputs.map((output) => output.delivery),
            plan.funding
        );
    }

    const result = WitnessBuilder.statement(
        plan.statement.circuitName,
        words,
        plan.statement.target
    );
    if (JSON.stringify(result) !== JSON.stringify(plan.statement)) {
        throw new Error("frozen operation statement changed");
    }
    return result;
}

export function authorizationRequest(plan: OperationPlan) {
    let operation: WalletOperation = "transact";
    if (plan.kind === "draw-credit") {
        operation = "credit-draw";
    } else if (
        plan.kind === "create-credit" ||
        plan.kind === "top-up-credit" ||
        plan.kind === "cancel-credit"
    ) {
        operation = plan.kind;
    }

    return {
        context: {
            chainId: plan.context.chainId,
            protocolAddress: BigInt(plan.context.protocolAddress),
        },
        operation,
        capacity: plan.capacity!,
        words: statement(plan).expectedPublicInputs.slice(0, -2).map(BigInt),
    };
}

export async function witnessFor(
    protocol: TokenProtocol,
    plan: OperationPlan,
    authorization?: AuthorizedStatement
): Promise<ProvingRequest> {
    const builder = new WitnessBuilder(protocol);
    const credit = plan.credit;

    if (credit) {
        if (!authorization) throw new Error("private Credit wallet authorization required");

        if (credit.topUp) {
            return builder.topUpCredit({
                params: credit.topUp,
                deliveries: credit.deliveries,
                funding: plan.funding,
                inputs: plan.inputs,
                state: credit.outputs[0]!.state,
                ...(plan.outputs[0] ? { change: plan.outputs[0].note } : {}),
                previous: credit.inputs[0]!,
                authorization,
            });
        }
        if (credit.creation) {
            return builder.createCredit({
                params: credit.creation,
                deliveries: credit.deliveries,
                funding: plan.funding,
                inputs: plan.inputs,
                state: credit.outputs[0]!.state,
                ...(plan.outputs[0] ? { change: plan.outputs[0].note } : {}),
                authorization,
            });
        }
        if (credit.draw) {
            return builder.drawCredit({
                timestamp: plan.preparedAt.timestamp,
                params: credit.draw,
                deliveries: credit.deliveries,
                inputs: credit.inputs,
                amounts: credit.amounts!,
                authorization,
            });
        }
        if (credit.cancel) {
            return builder.cancelCredit({
                params: credit.cancel,
                input: credit.inputs[0]!,
                authorization,
            });
        }
        throw new Error("unsupported Credit operation");
    }

    return builder.transact({
        params: plan.params!,
        deliveries: plan.outputs.map((output) => output.delivery),
        funding: plan.funding,
        inputs: plan.inputs,
        outputs: plan.outputs.map((output) => output.note),
        ...(authorization ? { authorization } : {}),
        target: plan.statement!.target,
    });
}

export async function encodeOperation(saved: SavedOperation): Promise<TransactionCall> {
    const plan = saved.plan;
    const credit = plan.credit;
    const caller = plan.fundingMode === "caller" ? plan.funding.payer : undefined;
    const common = { context: plan.context, proof: saved.proof?.proofHex ?? ("0x" as Hex) };
    const funded = { ...common, funding: plan.funding, ...(caller ? { caller } : {}) };

    let encoded: { data: Hex };
    if (credit?.topUp) {
        encoded = buildTopUpCreditCalldata({
            ...funded,
            params: credit.topUp,
            deliveries: credit.deliveries,
        });
    } else if (credit?.creation) {
        encoded = buildCreateCreditCalldata({
            ...funded,
            params: credit.creation,
            deliveries: credit.deliveries,
        });
    } else if (credit?.draw) {
        encoded = buildCreditDrawCalldata({
            ...common,
            params: credit.draw,
            deliveries: credit.deliveries,
        });
    } else if (credit?.cancel) {
        encoded = buildCancelCreditCalldata({ ...common, params: credit.cancel });
    } else if (plan.kind === "shield") {
        encoded = await buildShieldCalldata({
            ...funded,
            params: plan.shieldParams!,
            outputs: plan.shieldOutputs!,
            deliveries: plan.outputs.map((output) => output.delivery),
        });
    } else {
        encoded = buildTransactCalldata({
            ...funded,
            params: plan.params!,
            deliveries: plan.outputs.map((output) => output.delivery),
        });
    }

    return { to: plan.context.protocolAddress, data: encoded.data, value: 0n };
}

export async function fundingTypedData(saved: SavedOperation) {
    const plan = saved.plan;
    const credit = plan.credit;

    if (credit?.topUp) {
        return encodeTopUpCreditFundingTypedData(
            plan.context,
            credit.topUp,
            credit.deliveries,
            plan.funding
        );
    }
    if (credit?.creation) {
        return encodeCreateCreditFundingTypedData(
            plan.context,
            credit.creation,
            credit.deliveries,
            plan.funding
        );
    }
    if (plan.kind === "shield") {
        return encodeShieldFundingTypedData({
            context: plan.context,
            params: plan.shieldParams!,
            outputs: plan.shieldOutputs!,
            deliveries: plan.outputs.map((output) => output.delivery),
            funding: plan.funding,
        });
    }
    if (plan.statement?.target === "noir-recursive") {
        return encodeAggregateFundingTypedData(plan.context, {
            params: plan.params!,
            deliveries: plan.outputs.map((output) => output.delivery),
            funding: plan.funding,
        });
    }
    return encodeTransactFundingTypedData(
        plan.context,
        saved.proof!.proofHex,
        plan.params!,
        plan.outputs.map((output) => output.delivery),
        plan.funding
    );
}

/** Whitelist the public proof fields; a custom local backend cannot accidentally export its witness. */
export function publicProof(bundle: ProofBundle): ProofBundle {
    return {
        formatVersion: bundle.formatVersion,
        circuitName: bundle.circuitName,
        target: bundle.target,
        bbVersion: bundle.bbVersion,
        artifactSha256: bundle.artifactSha256,
        vkSha256: bundle.vkSha256,
        proofHex: bundle.proofHex,
        proofSha256: bundle.proofSha256,
        publicInputs: [...bundle.publicInputs],
    };
}

export function operationExpired(plan: OperationPlan, now: bigint): boolean {
    if (now > plan.deadline) return true;

    const credit = plan.credit;
    if (credit?.topUp && now >= credit.topUp.previousExpiry) return true;
    if (credit?.creation && now >= credit.creation.expiry) return true;
    if (credit?.draw) {
        if (credit.draw.expiries.some((expiry) => now >= expiry)) return true;
        const prepared = creditPeriods(plan.preparedAt.timestamp),
            current = creditPeriods(now);
        if (
            prepared.currentDay !== current.currentDay ||
            prepared.currentMonth !== current.currentMonth
        )
            return true;
    }
    return false;
}
