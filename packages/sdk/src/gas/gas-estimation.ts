import type { OperationPlan } from "../transactions/operation-types";
import { estimateGas, type GasShape } from "@invisi-labs/protocol";
import { operationSources } from "../transactions/preparation/inputs";
/** Pre-signing preview; the SDK owns both the receipt lookup and fallback model. */
export function estimateOperationGas(plan: OperationPlan, execution?: "direct" | "aggregate") {
    if (execution === "aggregate" || plan.statement?.target === "noir-recursive")
        return estimateGas({ kind: "aggregate" });
    const credit = plan.credit;
    let query: GasShape = { kind: plan.kind };
    const fee =
        credit?.creation?.feeAmount ??
        credit?.update?.feeAmount ??
        credit?.draw?.feeAmount ??
        credit?.revocation?.feeAmount ??
        plan.params?.feeAmount ??
        plan.shieldParams?.feeAmount ??
        0n;
    if (credit?.creation?.hasInitialPayment) {
        query = { kind: "create-credit-initial-payment" };
    } else if (credit?.creation?.hasInitialPayment === false) {
        query = { kind: "create-credit", creationAbi: "initial-payment" };
    } else if (credit?.creation?.creationAbi === "legacy") {
        query = { kind: "create-credit", creationAbi: "legacy" };
    } else if (credit?.draw) {
        query = {
            kind: "draw-credit",
            capacity: plan.capacity!,
            creditInputs: credit.inputs.length,
            distinctPayers: credit.draw.payers.length,
            sourceTrees: operationSources(plan).length,
        };
    } else if (credit?.revocation) {
        query = {
            kind: "revoke-credit",
            authorization:
                credit.revocationCaller?.toLowerCase() === credit.revocation.owner.toLowerCase()
                    ? "direct"
                    : "unknown",
        };
    } else if (plan.kind === "transfer") {
        query = {
            kind: "transact",
            capacity: plan.capacity!,
            noteInputs: plan.inputs.length,
            noteOutputs: plan.outputs.length,
            sourceTrees: operationSources(plan).length,
            deposit: (plan.funding.amount ?? 0n) > 0n,
            withdrawal: (plan.params?.withdrawalAmount ?? 0n) > 0n,
        };
    } else if (plan.kind === "shield") {
        query = { kind: "shield", noteOutputs: plan.outputs.length };
    }
    const extraNoteBytes = plan.outputs.reduce(
        (sum, o) =>
            sum +
            Math.max(0, (o.delivery.ciphertext.length - 2) / 2 - 160) +
            Math.max(0, (o.delivery.clue.length - 2) / 2 - 68),
        0
    );
    const extraCreditBytes =
        credit?.outputs.reduce(
            (sum, o) =>
                sum +
                o.deliveries.reduce(
                    (bytes, d) =>
                        bytes +
                        Math.max(0, (d.ciphertext.length - 2) / 2 - 485) +
                        Math.max(0, (d.clue.length - 2) / 2 - 68),
                    0
                ),
            0
        ) ?? 0;
    return estimateGas({
        ...query,
        feeEnabled: fee > 0n,
        extraDeliveryBytes: extraNoteBytes + extraCreditBytes,
        permit: (plan.funding.permit?.deadline ?? 0n) > 0n,
        fundingSignature: plan.fundingMode === "signature",
    });
}
export type { GasEstimate, GasShape } from "@invisi-labs/protocol";
