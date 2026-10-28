import { expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useOperation } from "./index";
import type { Operation } from "@invisi-labs/sdk";
it("tracks the same staged operation and retains its handle after a later stage fails", async () => {
    const prepared = { id: "one", status: "prepared" } as Operation,
        authorized = { id: "one", status: "authorized" } as Operation,
        { result } = renderHook(() => useOperation());
    await act(async () => {
        expect(await result.current.run(async () => prepared)).toBe(prepared);
    });
    expect(result.current.operation).toBe(prepared);
    expect(result.current.status).toBe("prepared");
    await act(async () => {
        await result.current.run(async () => authorized);
    });
    expect(result.current.operation).toBe(authorized);
    await act(async () => {
        await expect(
            result.current.run(async () => {
                throw new Error("secret witness content");
            })
        ).rejects.toThrow(/did not complete/);
    });
    expect(result.current.operation).toBe(authorized);
    expect(result.current.status).toBe("error");
    expect(JSON.stringify(result.current.error)).not.toContain("witness");
});
it("prevents concurrent stage execution and propagates cancellation without claiming transaction revocation", async () => {
    const { result } = renderHook(() => useOperation());
    let finish!: (value: Operation) => void,
        signal: AbortSignal | undefined,
        pending!: Promise<Operation>;
    act(() => {
        pending = result.current.run(async (received) => {
            signal = received;
            return new Promise((resolve) => {
                finish = resolve;
            });
        });
    });
    await expect(result.current.run(async () => ({}) as Operation)).rejects.toThrow(/running/);
    act(() => result.current.cancel());
    expect(signal?.aborted).toBe(true);
    await act(async () => {
        finish({ id: "one", status: "uncertain" } as Operation);
        await pending;
    });
    expect(result.current.operation?.id).toBe("one");
    expect(result.current.status).toBe("uncertain");
});
