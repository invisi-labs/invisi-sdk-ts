import { AbiCoder, Interface, keccak256, ParamType } from "ethers";
import type { Address, Hex } from "../contracts/index";
import { invisiProtocolAbi, type TransactRequest } from "../contracts/index";
import {
    dense,
    fundingFields,
    getEIP712Domain,
    normalizeFunding,
    validateFundingSubmission,
    word,
    type DeploymentContext,
    type FundingInput,
    type TransactionContext,
} from "../validation";
import { normalizeTransactRequest, selectTransactCapacity, transactPublicInputs } from "./request";

export interface BuildTransactAggregateCalldataParams {
    context: DeploymentContext & { now?: bigint };
    proof: Hex;
    requests: readonly TransactRequest[];
    caller?: Address;
}

export function buildTransactAggregateCalldata(p: BuildTransactAggregateCalldataParams) {
    if (![4, 8, 12].includes(dense(p.requests, "requests").length))
        throw new Error("aggregate requires 4, 8 or 12 requests");
    const requests = p.requests.map((request) => {
        const r = normalizeTransactRequest(
            { ...p.context, tokenAddress: request.params.token },
            request.params,
            request.deliveries,
            request.funding
        );
        if (r.capacity !== 14) throw new Error("aggregate supports only capacity 14");
        validateFundingSubmission(r.funding, p.caller, p.context.now);
        return {
            ...request,
            params: { ...request.params, feeRecipient: r.feeRecipient, feeAmount: r.feeAmount },
        };
    });
    return {
        data: new Interface(
            invisiProtocolAbi.filter(
                (item) =>
                    item.type === "function" &&
                    item.name === "transact" &&
                    item.inputs[1]?.type === "tuple[]"
            )
        ).encodeFunctionData("transact", [p.proof, requests]) as Hex,
        capacity: 14 as const,
    };
}

export type AggregateMemberInput = Pick<TransactRequest, "params" | "deliveries"> & {
    funding?: FundingInput;
};

/** Atomic aggregate funding binds the member statement rather than the aggregate proof bytes. */
export function aggregateMemberRequestHash(c: TransactionContext, r: AggregateMemberInput) {
    const capacity = selectTransactCapacity(
        r.params.nullifiers.length,
        r.params.outputCommitments.length
    );
    if (capacity !== 14) throw new Error("aggregate supports only capacity 14");
    return keccak256(
        AbiCoder.defaultAbiCoder().encode(
            ["bytes32", "uint256", "bytes32[]"].map((parameter) => ParamType.from(parameter)),
            [
                keccak256(new TextEncoder().encode("InvisiAtomicBatchMemberV1")),
                BigInt(capacity),
                transactPublicInputs(c, r.params, r.deliveries, r.funding),
            ]
        ) as Hex
    ) as Hex;
}

/** Router adapter business words (58 per member), not the aggregate circuit statement. */
export function aggregatePublicInputs(
    c: TransactionContext,
    requests: readonly AggregateMemberInput[]
) {
    if (![4, 8, 12].includes(dense(requests, "requests").length))
        throw new Error("aggregate requires 4, 8 or 12 requests");
    return requests.flatMap((r) => {
        const context = { ...c, tokenAddress: r.params.token };
        aggregateMemberRequestHash(context, r);
        return [word(14n), ...transactPublicInputs(context, r.params, r.deliveries, r.funding)];
    });
}

export function encodeAggregateFundingTypedData(c: TransactionContext, r: AggregateMemberInput) {
    const f = normalizeFunding(r.funding);
    if (f.amount === 0n) throw new Error("funding authorization requires positive deposit");
    return {
        domain: getEIP712Domain(c),
        primaryType: "FundTransact" as const,
        types: { FundTransact: fundingFields },
        message: {
            requestHash: aggregateMemberRequestHash(c, r),
            payer: f.payer,
            amount: f.amount,
            sigNonce: f.sigNonce,
            deadline: f.deadline,
        },
    };
}
