import { normalizeFunding } from "@invisi-labs/protocol";
import type { OperationPlan } from "./operation-types";
import type { OperationStatus } from "./records";
import { inputFacts, requiresAuthorization } from "./operation-protocol";
export function operationPreview(plan: OperationPlan, status: OperationStatus) {
    const p = plan;
    const fee = p.params ?? p.shieldParams ?? p.credit?.creation ?? p.credit?.cancel;
    const funding = normalizeFunding(p.funding);
    return {
        id: p.id,
        kind: p.kind,
        status,
        context: { ...p.context },
        inputs: inputFacts(p).length,
        inputDetails: [
            ...p.inputs.map((input) => ({
                kind: "notes" as const,
                commitment: input.commitment,
                amount: input.note.amount,
                owner: input.note.ownerAddress,
                treeId: input.treeId,
                leafIndex: input.leafIndex,
            })),
            ...(p.credit?.inputs ?? []).map((input) => ({
                kind: "credits" as const,
                commitment: input.commitment,
                amount: input.state.note.amount,
                owner: input.state.note.ownerWalletIdentity,
                spender: input.state.note.spenderWalletIdentity,
                expiry: input.state.note.expiry,
                role: input.role,
                treeId: input.treeId,
                leafIndex: input.leafIndex,
            })),
        ],
        funding: {
            payer: funding.payer,
            amount: funding.amount,
            authorization: p.fundingMode,
            sigNonce: funding.sigNonce,
            deadline: funding.deadline,
            permit: { deadline: funding.permit.deadline },
        },
        creditOutputs: p.credit?.outputs.map((output) => ({
            commitment: output.commitment,
            amount: output.state.note.amount,
            expiry: output.state.note.expiry,
            owner: output.state.note.ownerWalletIdentity,
            spender: output.state.note.spenderWalletIdentity,
            ownerPayout: output.state.note.ownerPayout,
            spenderPayout: output.state.note.spenderPayout,
        })),
        outputs: p.outputs.map((output) => ({
            commitment: output.commitment,
            to: output.address,
            amount: output.amount,
            change: output.change,
        })),
        capacity: p.capacity,
        deadline: p.deadline,
        feeRecipient: fee?.feeRecipient,
        feeAmount: fee?.feeAmount ?? 0n,
        fundingAmount: p.funding.amount ?? 0n,
        fundingPayer: p.funding.payer,
        withdrawalAmount:
            p.params?.withdrawalAmount ??
            p.credit?.draw?.totalAmount ??
            (p.credit?.cancel
                ? p.credit.cancel.amount - (p.credit.cancel.feeAmount ?? 0n)
                : undefined) ??
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
