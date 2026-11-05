import type { Hex, InputSource } from "@invisi-labs/protocol/contracts";
import type { OperationPlan } from "../operation-types";
import { creditReservationKey } from "../records";

export function inputFacts(
    plan: OperationPlan
): Array<{ key: string; reservationKey: string; nullifier: Hex; kind: "notes" | "credits" }> {
    const credit = plan.credit;
    const noteNullifiers = plan.params?.nullifiers ?? credit?.creation?.nullifiers ?? [];
    let creditNullifiers: readonly Hex[] = [];

    if (credit?.draw) {
        creditNullifiers = credit.draw.nullifiers;
    } else if (credit?.topUp) {
        creditNullifiers = [credit.topUp.creditNullifier];
    } else if (credit?.cancel) {
        creditNullifiers = [credit.cancel.nullifier];
    }

    if (
        noteNullifiers.length !== plan.inputs.length ||
        creditNullifiers.length !== (credit?.inputs.length ?? 0)
    ) {
        throw new Error("operation input statement count mismatch");
    }

    return [
        ...plan.inputs.map((input, index) => ({
            key: input.commitment,
            reservationKey: input.commitment,
            nullifier: noteNullifiers[index]!,
            kind: "notes" as const,
        })),
        ...(credit?.inputs ?? []).map((input, index) => ({
            key: input.commitment + ":" + input.role,
            reservationKey: creditReservationKey(input.commitment),
            nullifier: creditNullifiers[index]!,
            kind: "credits" as const,
        })),
    ];
}

export function operationSources(plan: OperationPlan): readonly InputSource[] {
    const noteSources = plan.params?.sources;
    if (noteSources != null) return noteSources;

    const credit = plan.credit;
    if (credit?.topUp) {
        return [...credit.topUp.creation.sources, credit.topUp.creditSource];
    }
    if (credit?.creation) return credit.creation.sources;
    if (credit?.draw) return credit.draw.sources;
    if (credit?.cancel) return [credit.cancel.source];
    return [];
}
