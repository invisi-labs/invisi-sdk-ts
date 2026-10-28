import { expect, it } from "vitest";
import { useOperation } from "./index";
import type { Operation } from "@invisi-labs/sdk";
it("preserves opaque class handles without proxying private fields and retains the prior stage on failure", async () => {
    class OpaqueHandle {
        #id = "one";
        get id() {
            return this.#id;
        }
        readonly status = "prepared" as const;
    }
    const state = useOperation(),
        prepared = new OpaqueHandle() as unknown as Operation;
    expect(await state.run(async () => prepared)).toBe(prepared);
    expect(state.operation.value).toBe(prepared);
    await expect(
        state.run(async () => {
            throw new Error("private witness");
        })
    ).rejects.toThrow(/did not complete/);
    expect(state.operation.value).toBe(prepared);
    expect(state.error.value?.message).not.toContain("witness");
});
it("rejects concurrent stage calls and retains a handle returned after cancellation", async () => {
    const state = useOperation();
    let finish!: (value: Operation) => void, signal: AbortSignal | undefined;
    const pending = state.run(async (received) => {
        signal = received;
        return new Promise<Operation>((resolve) => {
            finish = resolve;
        });
    });
    await expect(state.run(async () => ({}) as Operation)).rejects.toThrow(/running/);
    state.cancel();
    expect(signal?.aborted).toBe(true);
    finish({ id: "one", status: "uncertain" } as Operation);
    await pending;
    expect(state.status.value).toBe("uncertain");
});
