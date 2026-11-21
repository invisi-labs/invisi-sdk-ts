import { encodeCreateCreditCall, normalizeFunding } from "@invisi-labs/protocol";
import type { Hex } from "@invisi-labs/protocol/contracts";
import { invisiCoreAbi } from "@invisi-labs/protocol/contracts";
import { Interface } from "ethers";
import type { OperationPlan } from "../transactions/operation-types";
import { statement } from "../transactions/signing/statement";

/** Quote-only export; callers still need the operation-specific proof or owner authorization. */
export function exportBroadcasterIntent(plan: OperationPlan) {
    if (plan.statement && plan.statement.target !== "evm")
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
    } else if (plan.credit?.creation) {
        return {
            sendable: false as const,
            data: encodeCreateCreditCall(plan.credit.creation, "0x", plan.credit.deliveries),
        };
    } else if (plan.credit?.draw) {
        method = "creditDraw";
        args = ["0x", plan.credit.draw, plan.credit.deliveries];
    } else if (plan.credit?.update) {
        method = "updateCredit";
        args = ["0x", plan.credit.update, plan.credit.deliveries];
    } else if (plan.credit?.revocation) {
        const p = plan.credit.revocation;
        method = "revokeCredit";
        args = [
            p.token,
            p.owner,
            p.grantId,
            p.deadline,
            p.feeRecipient ?? "0x0000000000000000000000000000000000000000",
            p.feeAmount ?? 0n,
            "0x",
        ];
    } else throw new Error("unsupported broadcaster operation");
    const abi = invisiCoreAbi.filter(
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
