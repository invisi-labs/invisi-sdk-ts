import { type AuthorizedStatement } from "@invisi-labs/core";
import { WitnessBuilder, type TokenProtocol } from "@invisi-labs/protocol";
import type { ProvingRequest } from "@invisi-labs/prover";
import type { OperationPlan } from "../operation-types";

export async function witnessFor(
    protocol: TokenProtocol,
    plan: OperationPlan,
    authorization?: AuthorizedStatement
): Promise<ProvingRequest> {
    const builder = new WitnessBuilder(protocol);
    const credit = plan.credit;

    if (credit) {
        if (!authorization) throw new Error("private Credit wallet authorization required");

        if (credit.update)
            return builder.updateCredit({
                params: credit.update,
                deliveries: credit.deliveries,
                input: credit.inputs[0]!,
                state: credit.outputs[0]!.state,
                authorization,
            });
        if (credit.creation)
            return builder.createCredit({
                params: credit.creation,
                deliveries: credit.deliveries,
                state: credit.outputs[0]!.state,
                authorization,
            });
        if (credit.draw) {
            return builder.drawCredit({
                timestamp: plan.preparedAt.timestamp,
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
