import { useState, useRef, useCallback, useEffect } from "react";
import type { PreparedTransaction, RegistrationOperation } from "@invisi-labs/sdk";
import type { Operation } from "@invisi-labs/session";
type Handle = PreparedTransaction | Operation | RegistrationOperation;
/** Run explicit SDK stages. Cancel aborts work; it never revokes an external transaction. */
export function useOperation() {
    const [operation, setOperation] = useState<Handle | null>(null),
        [status, setStatus] = useState<Handle["status"] | "idle" | "running" | "error">("idle"),
        [error, setError] = useState<Error | null>(null);
    const active = useRef<AbortController | null>(null),
        mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            active.current?.abort();
        };
    }, []);
    const run = useCallback(
        async <T extends Handle>(action: (signal: AbortSignal) => Promise<T>): Promise<T> => {
            if (active.current) throw new Error("An operation stage is already running");
            const controller = new AbortController();
            active.current = controller;
            setError(null);
            setStatus("running");
            try {
                const result = await action(controller.signal);
                if (mounted.current) {
                    setOperation(result);
                    setStatus(result.status);
                }
                return result;
            } catch {
                const failure = new Error(
                    "Operation did not complete; recover its persisted state before retrying"
                );
                if (mounted.current) {
                    setError(failure);
                    setStatus("error");
                }
                throw failure;
            } finally {
                if (active.current === controller) active.current = null;
            }
        },
        []
    );
    const cancel = useCallback(() => active.current?.abort(), []);
    return { operation, status, error, run, cancel };
}
export type UseOperationResult = ReturnType<typeof useOperation>;
