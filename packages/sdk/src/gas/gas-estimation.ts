import type { TokenProtocol } from "@invisi-labs/rpc";
import type { OperationPlan } from "../transactions/operation-types";
import { getDocumentedGasReference, type DocumentedGasShape } from "@invisi-labs/protocol";
import { operationSources } from "../transactions/preparation/inputs";
/** A pre-proof documented scenario reference; conditions remain visible in the result. */
export function getOperationGasReference(plan: OperationPlan, _protocol?: TokenProtocol) {
    let query: DocumentedGasShape = { kind: plan.kind };
    const credit = plan.credit;
    if (plan.statement?.target === "noir-recursive")
        return getDocumentedGasReference({ kind: "aggregate" });
    if (credit?.creation)
        query = { kind: "create-credit", scenario: "first-allocation-empty-tree" };
    else if (credit?.update)
        query = { kind: "update-credit", scenario: "after-draw-preserve-usage" };
    else if (credit?.draw)
        query = {
            kind: "draw-credit",
            capacity: plan.capacity!,
            creditInputs: credit.inputs.length,
            distinctPayers: credit.draw.payers.length,
            sourceTrees: operationSources(plan).length,
            noteOutputs: 1,
            creditOutputs: credit.outputs.length,
            creditCiphertextBytes: 485,
            noteCiphertextBytes: 160,
            clueBytes: 68,
            scenario: "distinct-payers",
        };
    else if (plan.kind === "transfer")
        query = {
            kind: "transact",
            capacity: plan.capacity!,
            noteInputs: plan.inputs.length,
            noteOutputs: plan.outputs.length,
            sourceTrees: operationSources(plan).length,
            noteCiphertextBytes: 160,
            clueBytes: 68,
            scenario: !plan.inputs.length
                ? "public-funding"
                : !plan.outputs.length
                  ? "withdrawal"
                  : !(plan.funding.amount ?? 0n) &&
                      !(plan.params?.withdrawalAmount ?? 0n) &&
                      !(plan.params?.feeAmount ?? 0n)
                    ? "private"
                    : "mixed",
        };
    if (credit) {
        const feeAmount =
            credit.creation?.feeAmount ??
            credit.update?.feeAmount ??
            credit.draw?.feeAmount ??
            credit.revocation?.feeAmount ??
            0n;
        query = {
            ...query,
            feeEnabled: feeAmount > 0n,
            feeMechanism: feeAmount > 0n ? (credit.draw ? "draw-deduction" : "owner-pull") : "none",
        };
    }
    if (
        plan.outputs.some((o) => (o.delivery.ciphertext.length - 2) / 2 !== 160) ||
        credit?.outputs.some((o) => o.deliveries.some((d) => (d.ciphertext.length - 2) / 2 !== 485))
    )
        return getDocumentedGasReference({ kind: "unmeasured-delivery-size" });
    return getDocumentedGasReference(query);
}
export { getDocumentedGasReference } from "@invisi-labs/protocol";
export type { DocumentedGasReference, DocumentedGasShape } from "@invisi-labs/protocol";
