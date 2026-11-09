import { describe, it, expect } from "vitest";
import vectors from "./data/documented-reference-vectors.json";
import { getDocumentedGasReference } from "./documented-reference";
describe("documented gas references", () => {
    it("returns exact documented medians without extrapolation", () => {
        for (const v of vectors.vectors)
            if (!v.available)
                expect(getDocumentedGasReference(v.query)).toMatchObject({ available: false });
            else
                expect(getDocumentedGasReference(v.query)).toMatchObject({
                    available: true,
                    gasUnits: BigInt(v.gasUnits),
                    statistic: "median",
                    sampleCount: 3,
                });
    });
    it("does not invent aggregate or same-payer measurements", () => {
        for (const query of vectors.unsupported)
            expect(getDocumentedGasReference(query)).toMatchObject({ available: false });
    });
});

it.each(["matching", "missing", "different", "malformed"] as const)(
    "requires exact measured Credit manifest SHA identity: %s",
    async (scenario) => {
        const { vi } = await import("vitest");
        const { CIRCUIT_RELEASE } = await import("@invisi-labs/prover");
        const catalog = (await import("./data/documented-references.json")).default;
        const row = structuredClone(
            catalog.references.find((row) => row.shape.kind === "create-credit")!
        );
        const identity: Record<string, unknown> = { ...row.releaseIdentity };
        if (scenario !== "missing")
            identity.creditManifestSha256 =
                scenario === "matching"
                    ? CIRCUIT_RELEASE.credit.manifestSha256
                    : scenario === "different"
                      ? "0".repeat(64)
                      : "invalid";
        Object.assign(row, { releaseIdentity: identity });
        vi.resetModules();
        vi.doMock("./data/documented-references.json", () => ({
            default: { ...catalog, references: [row] },
        }));
        try {
            const { getDocumentedGasReference: lookup } = await import("./documented-reference");
            expect(lookup(row.shape)).toMatchObject({ available: scenario === "matching" });
        } finally {
            vi.doUnmock("./data/documented-references.json");
            vi.resetModules();
        }
    }
);
