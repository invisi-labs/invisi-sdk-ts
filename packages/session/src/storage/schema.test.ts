import { it, expect } from "vitest";
import { serializeState, deserializeState } from "./codec";
import { initialState } from "./store";
import type { WalletState } from "./state";
const scope = {
    namespace: "test",
    chainId: 31337n,
    protocolAddress: `0x${"11".repeat(20)}` as `0x${string}`,
    ownerAddress: `0x${"22".repeat(20)}` as `0x${string}`,
};
it("preserves current state and reservations through serialization", () => {
    const state = initialState(scope);
    state.reservations.note = "pending";
    expect(deserializeState(serializeState(state))).toEqual(state);
});
it("rejects unsupported internal store revisions", () => {
    const state = { ...initialState(scope), schemaVersion: 1 } as unknown as WalletState;
    expect(() => deserializeState(serializeState(state))).toThrow(
        "Unsupported wallet store schema"
    );
});
