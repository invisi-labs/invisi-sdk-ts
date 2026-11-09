import { it, expect } from "vitest";
import {
    AGGREGATE_ROUTES,
    selectAggregateRoute,
    computeWalletAuthorizationDigest,
} from "@invisi-labs/core";
import type { CircuitName, Hex } from "../circuits/circuit-types";
import {
    assertPublicInputs,
    aggregateCircuitPublicInputs,
    makeProofBundle,
    getCircuitMetadata,
} from "./proof-data";
import vectors from "../../../protocol/src/protocol-vectors.json";
const hex = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const words = (capacity: number, id: number) => {
    const w = Array<bigint>(17 + 3 * capacity).fill(0n);
    w[0] = 31337n;
    w[1] = 1n;
    w[2] = 2n;
    w[3] = 1n;
    w[4] = BigInt(capacity - 1);
    w[5] = 1n;
    w[6] = 1n;
    w[6 + capacity] = 1n;
    for (let j = 0; j < capacity; j++) w[6 + 2 * capacity + j] = BigInt(id * 1000 + j + 1);
    const at = 6 + 3 * capacity;
    if (capacity === 1) {
        w[at + 2] = 3n;
        w[at + 3] = 1n;
    }
    w[at + 4] = 900n;
    const digest = BigInt(
        computeWalletAuthorizationDigest({
            context: { chainId: w[0]!, protocolAddress: w[1]! },
            operation: "transact",
            capacity,
            words: w.slice(0, -2),
        })
    );
    w[w.length - 2] = digest >> 128n;
    w[w.length - 1] = digest & ((1n << 128n) - 1n);
    return w.map(hex);
};
export { words };
it("matches current independently generated Note authorization statements", () => {
    for (const n of [1, 15, 57, 113]) {
        const f = (vectors.fixtures as any)["transact" + n];
        const name = `transact_user_slots${(f.userPublicInputs.length - 17) / 3}` as CircuitName;
        expect(() => assertPublicInputs(name, f.userPublicInputs)).not.toThrow();
        const changed = [...f.userPublicInputs];
        changed[changed.length - 1] = hex(0n);
        expect(() => assertPublicInputs(name, changed)).toThrow(/digest/);
    }
});
it("packs and authenticates all34 dedicated/mixed outer routes", async () => {
    for (const route of AGGREGATE_ROUTES) {
        const caps =
            route.kind === "dedicated"
                ? Array(route.count).fill(route.capacity)
                : Array.from({ length: route.count }, (_, i) => (i % 5) + 1);
        expect(selectAggregateRoute(caps).name).toBe(route.name);
        const bundles = await Promise.all(
            caps.map((c, i) =>
                makeProofBundle(
                    `transact_user_slots${c}` as CircuitName,
                    "noir-recursive",
                    `0x${"00".repeat(458 * 32)}`,
                    words(c, i)
                )
            )
        );
        const packed = await aggregateCircuitPublicInputs(bundles);
        expect(packed).toHaveLength(route.publicInputCount);
        expect(() => assertPublicInputs(route.name as CircuitName, packed)).not.toThrow();
        const changed = [...packed];
        changed[changed.length - 1] = hex(0n);
        expect(() => assertPublicInputs(route.name as CircuitName, changed)).toThrow(/commitment/);
    }
});
it("rejects duplicate members, wrong targets and unsupported capacity/count combinations", async () => {
    const bundle = await makeProofBundle(
        "transact_user_slots2",
        "noir-recursive",
        `0x${"00".repeat(458 * 32)}`,
        words(2, 1)
    );
    await expect(aggregateCircuitPublicInputs([bundle, bundle])).rejects.toThrow(/Duplicate/);
    await expect(aggregateCircuitPublicInputs([{ ...bundle, target: "evm" }])).rejects.toThrow(
        /recursive/
    );
    expect(() => selectAggregateRoute([6, 7])).toThrow();
    expect(() => selectAggregateRoute([10, 10, 10])).toThrow();
});
