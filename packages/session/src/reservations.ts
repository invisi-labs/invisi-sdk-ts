import type { WalletScope, WalletStore } from "./state";
import { creditReservationKey } from "./state";
export function reserveInputs(
    store: WalletStore,
    scope: WalletScope,
    operationId: string,
    inputs: readonly string[]
): Promise<void> {
    if (!operationId.length || new Set(inputs).size !== inputs.length)
        throw new Error("invalid operation/input identifiers");
    const copied = [...inputs];
    return store.transaction(scope, (state) => {
        if (state.invalidated) throw new Error("wallet state requires canonical resync");
        if (state.operations[operationId]) throw new Error("operation already exists");
        const ids = copied.map((id) =>
            state.credits[id] ? creditReservationKey(state.credits[id]!.commitment) : id
        );
        if (new Set(ids).size !== ids.length) throw new Error("duplicate underlying input");
        for (const id of ids) {
            const records = state.notes[id]
                ? [state.notes[id]!]
                : Object.values(state.credits).filter(
                      (record) => creditReservationKey(record.commitment) === id
                  );
            if (
                !records.length ||
                records.some((input) => input.spent !== "unspent") ||
                state.reservations[id]
            )
                throw new Error("input unavailable or spent state unknown");
        }
        state.operations[operationId] = {
            id: operationId,
            status: "prepared",
            inputs: ids,
        };
        for (const id of ids) state.reservations[id] = operationId;
    });
}
export function releaseInputs(
    store: WalletStore,
    scope: WalletScope,
    operationId: string
): Promise<void> {
    return store.transaction(scope, (state) => {
        const operation = state.operations[operationId];
        if (!operation) throw new Error("unknown operation");
        if (
            (operation.payload as { externalized?: boolean; claim?: unknown } | undefined)
                ?.externalized ||
            (operation.payload as { claim?: unknown } | undefined)?.claim ||
            ["submitted", "uncertain", "reorged"].includes(operation.status)
        )
            throw new Error("submitted or uncertain inputs require chain reconciliation");
        for (const id of operation.inputs)
            if (state.reservations[id] === operationId) delete state.reservations[id];
        operation.status = "failed";
    });
}
