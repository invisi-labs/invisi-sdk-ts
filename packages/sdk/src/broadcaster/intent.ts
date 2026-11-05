import { normalizeFunding } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { invisiProtocolAbi } from "@invisi-labs/protocol/contracts";
import { Interface } from "ethers";
import type { OperationPlan } from "../transactions/operation-types";
import { statement } from "../transactions/signing/statement";

/** Public frozen request for quote signing. Empty proof/signature make this deliberately non-sendable. */
export function exportBroadcasterIntent(plan: OperationPlan) {
    if (plan.kind === "draw-credit" || (plan.statement && plan.statement.target !== "evm"))
        throw new Error("unsupported broadcaster operation");
    if (plan.statement) statement(plan);
    const feeDefaults = <T extends { feeRecipient?: string; feeAmount?: bigint }>(params: T) => ({
        ...params,
        feeRecipient: params.feeRecipient ?? "0x0000000000000000000000000000000000000000",
        feeAmount: params.feeAmount ?? 0n,
    });
    const funding = { ...normalizeFunding(plan.funding), signature: "0x" };
    let method: string;
    let args: unknown[];
    if (plan.params) {
        method = "transact";
        args = [
            "0x",
            {
                params: feeDefaults(plan.params),
                deliveries: plan.outputs.map((o) => o.delivery),
                funding,
            },
        ];
    } else if (plan.shieldParams) {
        method = "shield";
        args = [
            feeDefaults(plan.shieldParams),
            plan.shieldOutputs,
            plan.outputs.map((o) => o.delivery),
            funding,
        ];
    } else if (plan.credit?.topUp) {
        method = "topUpCredit";
        args = [
            "0x",
            { ...plan.credit.topUp, creation: feeDefaults(plan.credit.topUp.creation) },
            plan.credit.deliveries,
            funding,
        ];
    } else if (plan.credit?.creation) {
        method = "createCredit";
        args = ["0x", feeDefaults(plan.credit.creation), plan.credit.deliveries, funding];
    } else if (plan.credit?.cancel) {
        method = "cancelCredit";
        args = ["0x", feeDefaults(plan.credit.cancel)];
    } else throw new Error("unsupported broadcaster operation");
    const abi = invisiProtocolAbi.filter(
        (item) =>
            item.type === "function" &&
            item.name === method &&
            (method !== "transact" || item.inputs[1]?.type === "tuple")
    );
    return {
        sendable: false as const,
        data: new Interface(abi).encodeFunctionData(method, args) as Hex,
    };
}
