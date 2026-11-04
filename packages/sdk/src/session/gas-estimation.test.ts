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
    expect(profiles).toHaveLength(3);
    expect(profiles[2]!.measurements).toHaveLength(5);
    expect(profiles[2]!.measurements.every((m) => m.samples.length === 3)).toBe(true);
    expect(profiles[0]!.measurements).toHaveLength(13);
    expect(profiles[1]!.measurements).toHaveLength(9);
    expect(profiles[0]!.measurements.every((m) => m.samples.length === 3)).toBe(true);
    expect(() => defineGasBenchmarks({})).toThrow(/catalog/);
});

it("uses measured means for all eight direct operation kinds across deployments", () => {
    const profile = {
        ...defineGasBenchmarks(referenceProfiles)[0]!,
        measurements: defineGasBenchmarks(referenceProfiles).flatMap((p) => p.measurements),
    };
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
        const exact = profile.measurements.filter(
            (m) =>
                JSON.stringify(m.shape) === JSON.stringify(measurement.shape) &&
                JSON.stringify(m.circuit) === JSON.stringify(measurement.circuit)
        );
        const expected = exact
            .map((m) => {
                const n = BigInt(m.samples.length);
                return (m.samples.reduce((sum, s) => sum + BigInt(s.gasUsed), 0n) + n - 1n) / n;
            })
            .reduce((max, v) => (v > max ? v : max));
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

it("supports unmeasured mixed remainder counts within authenticated Credit capacities", () => {
    const profile = defineGasBenchmarks(referenceProfiles)[0]!;
    const measurement = profile.measurements.find((m) => m.shape.kind === "draw-credit")!;
    for (const capacity of [12, 50, 120]) {
        const estimate = estimateShapeGas({
            deployment: profile.deployment,
            shape: { ...measurement.shape, capacity, creditInputs: capacity },
            circuit: profile.measurements.find(
                (m) => m.shape.kind === "draw-credit" && m.shape.capacity === capacity
            )!.circuit,
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
    expect(() => estimateShapeGas(request)).toThrow(/No (current Credit )?gas reference/);
});

it("uses conservative duplicate policy variants for exact and modeled shapes in either order", () => {
    const profile = defineGasBenchmarks(referenceProfiles)[0]!;
    const topup = profile.measurements.find((m) => m.shape.kind === "top-up-credit")!;
    const cheap = { ...topup, samples: topup.samples.map((s) => ({ ...s, gasUsed: "100" })) };
    const expensive = {
        ...topup,
        id: "expensive-policy",
        samples: topup.samples.map((s) => ({ ...s, gasUsed: "300" })),
    };
    for (const measurements of [
        [cheap, expensive],
        [expensive, cheap],
    ]) {
        const profiles = [{ ...profile, measurements }];
        const request = {
            deployment: profile.deployment,
            shape: { ...topup.shape },
            circuit: topup.circuit,
        };
        expect(estimateShapeGas(request, profiles).gasUnits).toBe(300n);
        request.shape.funding = "signature";
        expect(estimateShapeGas(request, profiles).gasUnits).toBe(600n);
        request.shape.deliveryBytes += 256;
        const modeled = estimateShapeGas(request, profiles).gasUnits;
        expect(modeled).toBeGreaterThan(600n);
        expect(modeled).toBe(
            estimateShapeGas(request, [{ ...profile, measurements: [expensive] }]).gasUnits
        );
    }
});

it("rejects historical Credit identities and incomplete provenance", () => {
    const profile = defineGasBenchmarks(referenceProfiles)[0]!;
    const measurement = profile.measurements[0]!;
    expect(() =>
        estimateShapeGas({
            deployment: profile.deployment,
            shape: measurement.shape,
            circuit: { ...measurement.circuit!, artifactSha256: "00".repeat(32) },
        })
    ).toThrow(/No current Credit/);
    for (const field of ["fingerprints", "toolchain"] as const) {
        const invalid = structuredClone(profile);
        invalid.source[field] = {} as never;
        expect(() => defineGasBenchmarks([invalid])).toThrow(/catalog/);
    }
});
