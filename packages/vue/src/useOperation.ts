import { shallowRef, shallowReadonly, getCurrentScope, onScopeDispose } from "vue";
import type { Operation, RegistrationOperation } from "@invisi-labs/sdk";
type Handle = Operation | RegistrationOperation;
/** Opaque SDK objects stay unproxied; cancel does not revoke transactions or release input locks. */
export function useOperation() {
    const operation = shallowRef<Handle | null>(null),
        status = shallowRef<Handle["status"] | "idle" | "running" | "error">("idle"),
        error = shallowRef<Error | null>(null);
    let active: AbortController | null = null,
        disposed = false;
    if (getCurrentScope())
        onScopeDispose(() => {
            disposed = true;
            active?.abort();
        });
    async function run<T extends Handle>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (active) throw new Error("An operation stage is already running");
        const controller = new AbortController();
        active = controller;
        error.value = null;
        status.value = "running";
        try {
            const result = await action(controller.signal);
            if (!disposed) {
                operation.value = result;
                status.value = result.status;
            }
            return result;
        } catch {
            const failure = new Error(
                "Operation did not complete; recover its persisted state before retrying"
            );
            if (!disposed) {
                error.value = failure;
                status.value = "error";
            }
            throw failure;
        } finally {
            if (active === controller) active = null;
        }
    }
    // Readonly shallow refs preserve native private-field receivers.
    return {
        operation: shallowReadonly(operation),
        status: shallowReadonly(status),
        error: shallowReadonly(error),
        run,
        cancel: () => active?.abort(),
    };
}
export type UseOperationResult = ReturnType<typeof useOperation>;
