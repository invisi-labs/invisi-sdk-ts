import type { OperationPlan } from "./operation-types";
import type { OperationStatus } from "./state";
import { inputFacts, requiresAuthorization } from "./operation-protocol";
export function operationPreview(plan: OperationPlan, status: OperationStatus) {
    const p = plan;
    return {
        id: p.id,
        kind: p.kind,
        status,
        context: { ...p.context },
        inputs: inputFacts(p).length,
        creditOutputs: p.credit?.outputs.map((output) => ({
            amount: output.state.note.amount,
            expiry: output.state.note.expiry,
            owner: output.state.note.ownerWalletIdentity,
            spender: output.state.note.spenderWalletIdentity,
            ownerPayout: output.state.note.ownerPayout,
            spenderPayout: output.state.note.spenderPayout,
        })),
        outputs: p.outputs.map((output) => ({
            to: output.address,
            amount: output.note.amount,
            change: output.change,
        })),
        capacity: p.capacity,
        deadline: p.deadline,
        fundingAmount: p.funding.amount ?? 0n,
        fundingPayer: p.funding.payer,
        withdrawalAmount:
            p.params?.withdrawalAmount ??
            p.credit?.draw?.totalAmount ??
            p.credit?.cancel?.amount ??
            0n,
        withdrawalAddress:
            p.params?.withdrawalAddress ?? p.credit?.draw?.spender ?? p.credit?.cancel?.owner,
        permissions: {
            walletAuthorization: requiresAuthorization(p),
            proof: p.kind !== "shield",
            fundingAuthorization: p.fundingMode === "signature",
        },
    };
}
