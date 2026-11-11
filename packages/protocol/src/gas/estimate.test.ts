import { describe, it, expect } from "vitest";
import vectors from "./data/documented-reference-vectors.json";
import { estimateGas } from "./estimate";
describe("documented gas references", () => {
    it("returns exact documented medians without extrapolation", () => {
        for (const v of vectors.vectors)
            if (!v.available) expect(estimateGas(v.query)).toMatchObject({ available: false });
            else
                expect(estimateGas(v.query)).toMatchObject({
                    available: true,
                    gasUnits: BigInt(v.gasUnits),
                    statistic: "median",
                    sampleCount: 3,
                });
    });
    it("does not invent aggregate or same-payer measurements", () => {
        for (const query of vectors.unsupported)
            expect(estimateGas(query)).toMatchObject({ available: false });
    });
});

it.each(["matching", "missing", "different", "malformed"] as const)(
    "retains measurement identity as provenance without rejecting its release: %s",
    async (scenario) => {
        const { vi } = await import("vitest");
        const catalog = (await import("./data/documented-references.json")).default;
        const row = structuredClone(
            catalog.references.find((row) => row.shape.kind === "create-credit")!
        );
        const identity: Record<string, unknown> = { ...row.releaseIdentity };
        if (scenario === "missing") delete identity.creditManifestSha256;
        else if (scenario !== "matching")
            identity.creditManifestSha256 = scenario === "different" ? "0".repeat(64) : "invalid";
        Object.assign(row, { releaseIdentity: identity });
        vi.resetModules();
        vi.doMock("./data/documented-references.json", () => ({
            default: { ...catalog, references: [row] },
        }));
        try {
            const { estimateGas: estimate } = await import("./estimate");
            expect(estimate(row.shape)).toMatchObject({
                source: "benchmark",
                available: true,
                gasUnits: BigInt(row.gasUnits),
                releaseIdentity: identity,
            });
        } finally {
            vi.doUnmock("./data/documented-references.json");
            vi.resetModules();
        }
    }
);
