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
    const { prepareIntent, prepareBroadcasterPlan } =
        await import("@invisi-labs/sdk/session-support");

    const build = (
        intent: import("@invisi-labs/sdk/session-support").PreparationIntent,
        repricing: boolean
    ) =>
        prepareIntent(
            {
                options: runtime.options,
                ...(runtime.preparationReads ? { preparationReads: runtime.preparationReads } : {}),
                repricing,
                ...(runtime.store.readSummary
                    ? { readSummary: () => runtime.store.readSummary!(runtime.scope) }
                    : {}),
                scope: runtime.scope,
                reader: runtime.reader,
                readInventory: async () => {
                    const state = await runtime.store.readSnapshot(runtime.scope);
                    for (const [key, owner] of Object.entries(state.reservations))
                        if (owner === snapshot.plan.id) delete state.reservations[key];
                    return state;
                },
                complete: async (plan) => plan,
            },
            intent
        );
    const reprepare = (intent: import("@invisi-labs/sdk/session-support").PreparationIntent) =>
        runtime.preparationReads
            ? runtime.preparationReads.reprice((reuse) => build(intent, reuse))
            : build(intent, false);
    const selected = await prepareBroadcasterPlan(snapshot.plan, reprepare, client, options);
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
                    (!state.reservations[fact.reservationKey] ||
                        state.reservations[fact.reservationKey] === snapshot.plan.id),
                "input unavailable or already reserved"
            );
        for (const [key, owner] of Object.entries(state.reservations))
            if (owner === snapshot.plan.id) delete state.reservations[key];
        for (const fact of facts) state.reservations[fact.reservationKey] = snapshot.plan.id;
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
