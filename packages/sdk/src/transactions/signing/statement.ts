import { creditPeriods, type WalletOperation } from "@invisi-labs/primitives";
import { WitnessBuilder } from "@invisi-labs/prover";
import {
    createCreditPublicInputs,
    creditDrawPublicInputs,
    updateCreditPublicInputs,
    transactUserPublicInputs,
} from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { ProofStatement } from "@invisi-labs/prover";
import type { OperationPlan } from "../operation-types";

export function requiresAuthorization(plan: OperationPlan): boolean {
    if (plan.credit?.revocation) return false;
    // Derive the exemption from the actual frozen transaction, never an API/mode flag.
    const ownerOnlyFullWithdrawal =
        !plan.credit &&
        plan.inputs.length > 0 &&
        plan.outputs.length === 0 &&
        plan.params !== undefined &&
        plan.params.noteCommitments.length === 0 &&
        (plan.params.feeAmount ?? 0n) === 0n &&
        BigInt(plan.params.feeRecipient ?? 0n) === 0n &&
        (plan.funding.amount ?? 0n) === 0n &&
        plan.fundingMode === "none" &&
        BigInt(plan.params.withdrawalAddress) === BigInt(plan.scope.ownerAddress) &&
        plan.params.withdrawalAmount ===
            plan.inputs.reduce((sum, input) => sum + input.note.amount, 0n) &&
        plan.inputs.every((input) => input.note.ownerAddress === plan.scope.ownerAddress);
    if (ownerOnlyFullWithdrawal) return false;
    return !!plan.credit || plan.inputs.length > 0;
}

export function statement(plan: OperationPlan): ProofStatement {
    if (!plan.statement) throw new Error("operation has no proof statement");

    const credit = plan.credit;
    let words: Hex[];
    if (credit?.update)
        words = updateCreditPublicInputs(plan.context, credit.update, credit.deliveries);
    else if (credit?.creation)
        words = createCreditPublicInputs(plan.context, credit.creation, credit.deliveries);
    else if (credit?.draw)
        words = creditDrawPublicInputs(plan.context, credit.draw, credit.deliveries);
    else {
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
    } else if (plan.kind === "create-credit" || plan.kind === "update-credit") {
        operation = plan.credit?.creation?.hasInitialPayment
            ? "create-credit-initial-payment"
            : plan.kind;
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

export function operationExpired(plan: OperationPlan, now: bigint): boolean {
    if (now > plan.deadline) return true;

    const credit = plan.credit;
    if (credit?.inputs.some((i) => now > i.state.note.expiry)) return true;
    if (credit?.draw || credit?.creation?.hasInitialPayment) {
        const prepared = creditPeriods(plan.context.now ?? plan.preparedAt.timestamp),
            current = creditPeriods(now);
        if (
            prepared.currentDay !== current.currentDay ||
            prepared.currentMonth !== current.currentMonth
        )
            return true;
    }
    return false;
}
