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
