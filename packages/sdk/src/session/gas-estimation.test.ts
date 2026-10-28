import { expect, it } from "vitest";
import { fixture } from "./operation-fixture";
import { defineGasBenchmarks, estimateShapeGas } from "../gas-estimation";
import referenceProfiles from "../data/gas-benchmarks.json";

it("returns only gasUnits before proving, including on another deployment", async () => {
    const h = await fixture();
    const prepared = await h.session.prepareTransfer({
        tokenAddress: h.context.tokenAddress,
        outputs: [{ to: h.bob.getAddress(), amount: 30n }],
    });
    const estimate = prepared.estimateGas();
    expect(Object.keys(estimate)).toEqual(["gasUnits"]);
    expect(estimate.gasUnits).toBeGreaterThan(0n);
    expect(estimate).not.toBeInstanceOf(Promise);
    expect(prepared.estimateGas()).toEqual(estimate);
});

it("keeps complete real receipt evidence internally", () => {
    const profiles = defineGasBenchmarks(referenceProfiles);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]!.measurements).toHaveLength(13);
    expect(profiles[0]!.measurements.every((m) => m.samples.length === 3)).toBe(true);
    expect(() => defineGasBenchmarks({})).toThrow(/catalog/);
});

it("uses measured means for all eight direct operation kinds across deployments", () => {
    const profile = defineGasBenchmarks(referenceProfiles)[0]!;
    const kinds = new Set<string>();
    for (const measurement of profile.measurements) {
        kinds.add(measurement.shape.kind);
        const result = estimateShapeGas({
            deployment: {
                ...profile.deployment,
                chainId: "42161",
                protocolAddress: `0x${"11".repeat(20)}`,
                tokenAddress: `0x${"22".repeat(20)}`,
            },
            shape: measurement.shape,
            circuit: measurement.circuit,
        });
        const count = BigInt(measurement.samples.length);
        const expected =
            (measurement.samples.reduce((sum, sample) => sum + BigInt(sample.gasUsed), 0n) +
                count -
                1n) /
            count;
        expect(result).toEqual({ gasUnits: expected });
    }
    expect(kinds.size).toBe(8);
});

it("provides upward-only references for unmeasured counts and funding paths", () => {
    const profile = defineGasBenchmarks(referenceProfiles)[0]!;
    for (const measurement of profile.measurements) {
        const request = {
            deployment: profile.deployment,
            shape: { ...measurement.shape },
            circuit: measurement.circuit,
        };
        const baseline = estimateShapeGas(request).gasUnits;
        request.shape.noteInputs += 2;
        request.shape.sourceTrees += 2;
        const expanded = estimateShapeGas(request);
        expect(Object.keys(expanded)).toEqual(["gasUnits"]);
        expect(expanded.gasUnits).toBeGreaterThanOrEqual(baseline);
        request.shape.funding = "signature";
        request.shape.permit = true;
        expect(estimateShapeGas(request).gasUnits).toBeGreaterThanOrEqual(expanded.gasUnits);
    }
});

it("supports unmeasured Credit draw capacities without inventing receipt records", () => {
    const profile = defineGasBenchmarks(referenceProfiles)[0]!;
    const measurement = profile.measurements.find((m) => m.shape.kind === "draw-credit")!;
    for (const capacity of [12, 50, 120]) {
        const estimate = estimateShapeGas({
            deployment: profile.deployment,
            shape: { ...measurement.shape, capacity, creditInputs: capacity },
            circuit: { ...measurement.circuit!, circuitName: `credit_draw_slots${capacity}` },
        });
        expect(estimate.gasUnits).toBeGreaterThan(0n);
    }
    expect(profile.measurements).toHaveLength(13);
});

it("rejects standalone recursive members and unknown operation targets", () => {
    const profile = defineGasBenchmarks(referenceProfiles)[0]!;
    const measurement = profile.measurements[3]!;
    const request = {
        deployment: profile.deployment,
        shape: { ...measurement.shape, target: "noir-recursive" },
        circuit: measurement.circuit,
    };
    expect(() => estimateShapeGas(request)).toThrow(/complete aggregate/);
    request.shape.target = "unknown";
    expect(() => estimateShapeGas(request)).toThrow(/No gas reference/);
});
