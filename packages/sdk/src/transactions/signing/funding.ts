import {
    encodeAggregateFundingTypedData,
    encodeCreateCreditFundingTypedData,
    encodeShieldFundingTypedData,
    encodeTopUpCreditFundingTypedData,
    encodeTransactFundingTypedData,
} from "@invisi-labs/protocol";
import type { SavedOperation } from "../operation-types";

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
