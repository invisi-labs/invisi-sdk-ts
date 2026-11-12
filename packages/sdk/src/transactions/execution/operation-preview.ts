import { normalizeCreditPolicy, normalizeCreditUsage } from "@invisi-labs/primitives";
import { normalizeFunding } from "@invisi-labs/protocol";
import type { OperationPlan } from "../operation-types";
import { inputFacts } from "../preparation/inputs";
import type { OperationStatus } from "../records";
import { requiresAuthorization } from "../signing/statement";
export function operationPreview(plan: OperationPlan, status: OperationStatus) {
    const p = plan;
    const fee =
        p.params ??
        p.shieldParams ??
        p.credit?.creation ??
        p.credit?.update ??
        p.credit?.draw ??
        p.credit?.revocation;
    const funding = normalizeFunding(p.funding);
    return {
        id: p.id,
        kind: p.kind,
        status,
        submissionValidation: p.submissionValidation,
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
                revocationShard: input.state.note.revocationShard,
                revocationSlot: input.state.note.revocationSlot,
                owner: input.state.note.ownerWalletIdentity,
                spender: input.state.note.spenderWalletIdentity,
                expiry: input.state.note.expiry,
                availableCredit: input.state.note.availableCredit,
                unlimited: input.state.note.unlimited,
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
            revocationShard: output.state.note.revocationShard,
            revocationSlot: output.state.note.revocationSlot,
            expiry: output.state.note.expiry,
            owner: output.state.note.ownerWalletIdentity,
            spender: output.state.note.spenderWalletIdentity,
            ...normalizeCreditPolicy(output.state.note),
            availableCredit: output.state.note.availableCredit,
            unlimited: output.state.note.unlimited,
            ...normalizeCreditUsage(output.state.note),
        })),
        creditUpdate: p.credit?.updateChanges ? structuredClone(p.credit.updateChanges) : undefined,
        creditDraw: p.credit?.draw
            ? {
                  grossAmount: p.credit.draw.totalAmount,
                  feeAmount: p.credit.draw.feeAmount ?? 0n,
                  netAmount: p.credit.draw.totalAmount - (p.credit.draw.feeAmount ?? 0n),
                  payers: p.credit.draw.payers.map((payer) => ({ ...payer })),
              }
            : undefined,
        creditFeePayer:
            p.credit?.creation?.owner ?? p.credit?.update?.owner ?? p.credit?.revocation?.owner,
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
        withdrawalAmount: p.params?.withdrawalAmount ?? 0n,
        withdrawalAddress: p.params?.withdrawalAddress,
        permissions: {
            walletAuthorization: requiresAuthorization(p),
            proof: p.kind !== "shield" && p.kind !== "revoke-credit",
            fundingAuthorization: p.fundingMode === "signature",
        },
    };
}
