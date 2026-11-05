import type { Address } from "@invisi-labs/protocol/contracts";
import { Interface, type Result } from "ethers";

import { invisiProtocolAbi, type TransactRequest } from "@invisi-labs/protocol/contracts";
import { buildTransactCalldata, type TransactionCall } from "@invisi-labs/protocol";
import type { SavedOperation } from "./operation-types";
const aggregateAbi = invisiProtocolAbi.filter(
    (item) =>
        item.type === "function" &&
        item.name === "transact" &&
        item.inputs.length === 2 &&
        item.inputs[1]?.type === "tuple[]"
);
/** Match the whole frozen member, including funding nonce, signature and permit, in one successful aggregate. */
export function matchesAggregateTransaction(
    saved: SavedOperation,
    transaction: TransactionCall & { from: Address }
): boolean {
    const plan = saved.plan;
    if (
        plan.statement?.target !== "noir-recursive" ||
        !plan.params ||
        !saved.externalized ||
        transaction.to.toLowerCase() !== plan.context.protocolAddress.toLowerCase() ||
        transaction.value !== 0n
    )
        return false;
    try {
        const decoded = new Interface(aggregateAbi).parseTransaction({ data: transaction.data })!,
            requests = (decoded.args[1] as Result[]).map((request) => {
                const member = request.toObject(true);
                member.params.sources = request.params.sources.map((source: Result) =>
                    source.toObject(true)
                );
                member.params.nullifiers = request.params.nullifiers.toArray(true);
                member.params.outputCommitments = request.params.outputCommitments.toArray(true);
                member.deliveries = request.deliveries.map((delivery: Result) =>
                    delivery.toObject(true)
                );
                member.funding.permit.v = Number(member.funding.permit.v);
                return {
                    params: member.params,
                    deliveries: member.deliveries,
                    funding: member.funding,
                };
            }) as readonly TransactRequest[];
        if (
            decoded.name !== "transact" ||
            !Array.isArray(requests) ||
            ![4, 8, 12].includes(requests.length)
        )
            return false;
        const canonical = (request: TransactRequest) =>
            buildTransactCalldata({
                context: { ...plan.context, tokenAddress: request.params.token },
                proof: "0x00",
                params: request.params,
                deliveries: request.deliveries,
                funding: request.funding,
                caller: transaction.from,
            }).data.toLowerCase();
        const expected = buildTransactCalldata({
            context: plan.context,
            proof: "0x00",
            params: plan.params,
            deliveries: plan.outputs.map((output) => output.delivery),
            funding: plan.funding,
            caller: transaction.from,
        }).data.toLowerCase();
        return requests.filter((request) => canonical(request) === expected).length === 1;
    } catch {
        return false;
    }
}
