import { Interface } from "ethers";
import type { Address, Hex } from "../contracts/index";
import { invisiCoreAbi, type Delivery, type TransactRequest } from "../contracts/index";
import {
    validateFundingSubmission,
    type FundingInput,
    type TransactionContext,
} from "../validation";
import { normalizeTransactRequest, TransactRequestParams } from "./request";

export interface BuildTransactCalldataParams {
    context: TransactionContext;
    proof: Hex;
    params: TransactRequestParams;
    deliveries: readonly Delivery[];
    funding?: FundingInput;
    caller?: Address;
}

export function buildTransactCalldata(p: BuildTransactCalldataParams) {
    const r = normalizeTransactRequest(p.context, p.params, p.deliveries, p.funding);
    validateFundingSubmission(r.funding, p.caller, p.context.now);
    const request: TransactRequest = {
        params: {
            token: r.tokenAddress,
            sources: r.sources,
            nullifiers: r.nullifiers,
            noteCommitments: r.noteCommitments,
            withdrawalAddress: r.withdrawalAddress,
            withdrawalAmount: r.withdrawalAmount,
            deadline: r.deadline,
            feeRecipient: r.feeRecipient,
            feeAmount: r.feeAmount,
        },
        deliveries: p.deliveries,
        funding: r.funding,
    };
    const abi = invisiCoreAbi.filter(
        (item) =>
            item.type === "function" &&
            item.name === "transact" &&
            item.inputs.length === 2 &&
            item.inputs[1]?.type === "tuple"
    );
    const data = new Interface(abi).encodeFunctionData("transact", [p.proof, request]) as Hex;
    return { data, capacity: r.capacity, approveAmount: r.depositAmount };
}
