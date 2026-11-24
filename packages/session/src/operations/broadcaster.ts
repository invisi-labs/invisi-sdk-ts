import { inputFacts } from "@invisi-labs/sdk/session-support";
import type { OperationRuntime, SavedOperation } from "./operation-types";
function check(ok: unknown, message: string): asserts ok {
    if (!ok) {
        throw new Error(message);
    }
}
export async function quoteManagedOperation(
    runtime: OperationRuntime,
    snapshot: SavedOperation,
    client: import("@invisi-labs/sdk").BroadcasterClient,
    options: import("@invisi-labs/sdk/session-support").BroadcasterQuoteOptions
): Promise<SavedOperation> {
    const { prepareBroadcasterPlan } = await import("@invisi-labs/sdk/session-support");
    const selected = await prepareBroadcasterPlan(snapshot.plan, client, {
        ...options,
        ...(options.schedule && !options.persistSchedule
            ? { persistSchedule: async () => {} }
            : {}),
    });
    const saved = await runtime.store.transaction(runtime.scope, (state) => {
        const record = state.operations[snapshot.plan.id];
        const old = record?.payload as SavedOperation;
        check(
            record?.status === "prepared" &&
                old?.generation === snapshot.generation &&
                !old.claim &&
                !old.externalized,
            "stale operation or active worker"
        );
        check(!state.invalidated, "wallet state requires canonical resync");
        const nextPlan = { ...selected.plan, id: snapshot.plan.id };
        const facts = inputFacts(nextPlan);
        for (const fact of facts)
            check(
                state[fact.kind][fact.key]?.spent === "unspent" &&
                    state.reservations[fact.reservationKey] === snapshot.plan.id,
                "input unavailable or already reserved"
            );
        const next: SavedOperation = {
            plan: nextPlan,
            broadcasterQuote: selected.quote,
            broadcasterBinding: selected.broadcasterBinding,
            generation: old.generation + 1,
        };
        record.payload = next;
        record.inputs = facts.map((fact) => fact.reservationKey);
        record.deadline = nextPlan.deadline;
        return structuredClone(next);
    });
    return saved;
}
