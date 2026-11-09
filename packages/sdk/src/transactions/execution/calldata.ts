import {
    buildRevokeCreditCalldata,
    buildCreateCreditCalldata,
    buildCreditDrawCalldata,
    buildShieldCalldata,
    buildUpdateCreditCalldata,
    buildTransactCalldata,
    type TransactionCall,
} from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import type { SavedOperation } from "../operation-types";

export async function encodeOperation(saved: SavedOperation): Promise<TransactionCall> {
    const plan = saved.plan;
    const credit = plan.credit;
    const caller = plan.fundingMode === "caller" ? plan.funding.payer : undefined;
    const common = { context: plan.context, proof: saved.proof?.proofHex ?? ("0x" as Hex) };
    const funded = { ...common, funding: plan.funding, ...(caller ? { caller } : {}) };

    let encoded: { data: Hex };
    if (credit?.update) {
        encoded = buildUpdateCreditCalldata({
            ...funded,
            params: credit.update,
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
    } else if (credit?.revocation) {
        encoded = buildRevokeCreditCalldata({
            context: plan.context,
            params: credit.revocation,
            signature: credit.revocationSignature ?? "0x",
            ...(credit.revocationCaller ? { caller: credit.revocationCaller } : {}),
        });
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
