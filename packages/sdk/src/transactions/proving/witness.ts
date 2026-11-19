import { assertCreditUpdatePlan } from "../../credit/state";
import { type AuthorizedStatement } from "@invisi-labs/primitives";
import { WitnessBuilder } from "@invisi-labs/prover";
import type { ProvingRequest } from "@invisi-labs/prover";
import type { OperationPlan } from "../operation-types";

export async function witnessFor(
    plan: OperationPlan,
    authorization?: AuthorizedStatement
): Promise<ProvingRequest> {
    const builder = new WitnessBuilder({ context: plan.context });
    const credit = plan.credit;

    if (credit) {
        if (!authorization) throw new Error("private Credit wallet authorization required");

        if (credit.update) {
            await assertCreditUpdatePlan(plan);
            if (!credit.updateChanges) throw Error("Credit update adjustment required");
            return builder.updateCredit({
                params: credit.update,
                deliveries: credit.deliveries,
                input: credit.inputs[0]!,
                state: credit.outputs[0]!.state,
                changes: credit.updateChanges,
                authorization,
            });
        }
        if (credit.creation)
            return builder.createCredit({
                params: credit.creation,
                deliveries: credit.deliveries,
                state: credit.outputs[0]!.state,
                authorization,
                ...(credit.creation.hasFirstDraw
                    ? {
                          firstDraw: {
                              initialAvailableCredit: credit.firstDrawInitialAvailableCredit!,
                              output: plan.outputs[0]!.note!,
                          },
                      }
                    : {}),
            });
        if (credit.draw) {
            return builder.drawCredit({
                timestamp: plan.context.now ?? plan.preparedAt.timestamp,
                params: credit.draw,
                deliveries: credit.deliveries,
                inputs: credit.inputs,
                amounts: credit.amounts!,
                output: plan.outputs[0]!.note!,
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
        outputs: plan.outputs.map((output) => ({
            identity: output.identity,
            amount: output.amount,
            ...(output.note ? { note: output.note } : {}),
        })),
        ...(authorization ? { authorization } : {}),
        target: plan.statement!.target,
    });
}
