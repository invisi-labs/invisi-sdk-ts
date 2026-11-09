import {
    encodeAggregateFundingTypedData,
    encodeShieldFundingTypedData,
    encodeTransactFundingTypedData,
} from "@invisi-labs/protocol";
import type { SavedOperation } from "../operation-types";

export async function fundingTypedData(saved: SavedOperation) {
    const plan = saved.plan;
    if (plan.credit) throw Error("Credit operations have no funding authorization");
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
