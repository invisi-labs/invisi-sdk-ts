import type { Hex } from "@invisi-labs/protocol/contracts";

import {
    computeCreditCommitment,
    deriveCreditUpdate,
    type CreditDeliveryState,
} from "@invisi-labs/primitives";
export async function creditLeaf(state: CreditDeliveryState): Promise<Hex> {
    return computeCreditCommitment(state.note);
}

/** Rebuild from the original input and delta; cached output balances are never update intent. */
export async function assertCreditUpdatePlan(
    plan: import("../transactions/operation-types").OperationPlan
): Promise<void> {
    const credit = plan.credit;
    if (!credit?.update) return;
    const input = credit.inputs[0],
        output = credit.outputs[0],
        changes = credit.updateChanges;
    if (!input || !output || !changes)
        throw Error("Credit update input, output and adjustment required");
    const derived = await deriveCreditUpdate(input.state.note, changes, plan.deadline);
    if (
        derived.nullifier !== credit.update.nullifier ||
        derived.stateCommitment !== credit.update.creditCommitment ||
        output.commitment !== derived.stateCommitment ||
        (await computeCreditCommitment(output.state.note)) !== derived.stateCommitment
    )
        throw Error("Credit update adjustment does not match frozen successor");
}
