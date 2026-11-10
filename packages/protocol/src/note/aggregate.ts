import { selectAggregateRoute } from "./aggregate-routes";
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
    const route = selectAggregateRoute(
        dense<TransactRequest>(p.requests, "requests").map((r) =>
            selectTransactCapacity(r.params.nullifiers.length, r.params.noteCommitments.length)
        )
    );
    const requests = p.requests.map((request) => {
        const r = normalizeTransactRequest(
            { ...p.context, tokenAddress: request.params.token },
            request.params,
            request.deliveries,
            request.funding
        );
        if (r.capacity > 10) throw Error("aggregate supports C1..C10");
        validateFundingSubmission(r.funding, p.caller, p.context.now);
        return {
            ...request,
            params: { ...request.params, feeRecipient: r.feeRecipient, feeAmount: r.feeAmount },
        };
    });
    const approvalRequirements: { token: Address; payer: Address; amount: bigint }[] = [];
    for (const request of requests) {
        const funding = normalizeFunding(request.funding);
        if (funding.amount === 0n) continue;
        const token = request.params.token;
        const existing = approvalRequirements.find(
            (item) =>
                item.token.toLowerCase() === token.toLowerCase() &&
                item.payer.toLowerCase() === funding.payer.toLowerCase()
        );
        if (existing) existing.amount += funding.amount;
        else approvalRequirements.push({ token, payer: funding.payer, amount: funding.amount });
    }
    return {
        data: new Interface(
            invisiProtocolAbi.filter(
                (item) =>
                    item.type === "function" &&
                    item.name === "transact" &&
                    item.inputs[1]?.type === "tuple[]"
            )
        ).encodeFunctionData("transact", [p.proof, requests]) as Hex,
        capacity: route.capacity,
        approvalRequirements,
    };
}

export type AggregateMemberInput = Pick<TransactRequest, "params" | "deliveries"> & {
    funding?: FundingInput;
};

/** Atomic aggregate funding binds the member statement rather than the aggregate proof bytes. */
export function aggregateMemberRequestHash(c: TransactionContext, r: AggregateMemberInput) {
    const capacity = selectTransactCapacity(
        r.params.nullifiers.length,
        r.params.noteCommitments.length
    );
    if (capacity > 10) throw Error("aggregate supports C1..C10");
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
    selectAggregateRoute(
        dense<AggregateMemberInput>(requests, "requests").map((r) =>
            selectTransactCapacity(r.params.nullifiers.length, r.params.noteCommitments.length)
        )
    );
    return requests.flatMap((r) => {
        const context = { ...c, tokenAddress: r.params.token };
        aggregateMemberRequestHash(context, r);
        return [
            word(
                BigInt(
                    selectTransactCapacity(
                        r.params.nullifiers.length,
                        r.params.noteCommitments.length
                    )
                )
            ),
            ...transactPublicInputs(context, r.params, r.deliveries, r.funding),
        ];
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
