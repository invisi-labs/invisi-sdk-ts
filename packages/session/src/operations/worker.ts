import { type AuthorizedStatement } from "@invisi-labs/core";
import type { OperationRecord, OperationStatus } from "../storage/state";
import type { OperationRuntime, SavedOperation } from "./operation-types";
function check(ok: unknown, message: string): asserts ok {
    if (!ok) {
        throw new Error(message);
    }
}
export function currentOperation(
    record: OperationRecord | undefined,
    generation: number
): SavedOperation {
    check(record, "unknown operation");
    const saved = record.payload as SavedOperation;
    check(
        saved.generation === generation && !saved.claim,
        "stale operation handle or active worker; recover the operation"
    );
    return saved;
}
export async function runOperationStage(
    runtime: OperationRuntime,
    snapshot: SavedOperation,
    stage: string,
    allowed: OperationStatus[],
    work: (
        saved: SavedOperation
    ) => Promise<{ status: OperationStatus; authorization?: AuthorizedStatement }>,
    signal?: AbortSignal
): Promise<{
    saved: SavedOperation;
    status: OperationStatus;
    authorization?: AuthorizedStatement;
}> {
    signal?.throwIfAborted();
    const { store, scope } = runtime;
    const token = crypto.randomUUID();
    const saved = await store.transaction(scope, (state) => {
        check(!state.invalidated, "wallet requires canonical resync");
        const record = state.operations[snapshot.plan.id];
        const current = currentOperation(record, snapshot.generation);
        check(allowed.includes(record!.status), `invalid operation stage for ${stage}`);
        current.generation++;
        current.claim = { stage, token };
        return structuredClone(current);
    });
    try {
        const next = await work(saved);
        signal?.throwIfAborted();
        await store.transaction(scope, (state) => {
            check(!state.invalidated, "wallet invalidated during operation");
            const record = state.operations[snapshot.plan.id];
            const current = record?.payload as SavedOperation;
            check(
                record &&
                    current?.generation === saved.generation &&
                    current.claim?.token === token &&
                    allowed.includes(record.status),
                "stale operation worker after recovery"
            );
            delete saved.claim;
            record.status = next.status;
            record.payload = structuredClone(saved);
        });
        return { saved, ...next };
    } catch (error) {
        await store.transaction(scope, (state) => {
            const current = state.operations[snapshot.plan.id]?.payload as
                SavedOperation | undefined;
            if (current?.claim?.token === token) {
                delete current.claim;
            }
        });
        throw error;
    }
}
