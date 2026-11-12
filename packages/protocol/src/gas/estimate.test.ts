import { describe, it, expect } from "vitest";
import measured from "./data/measured-model.json";
import validation from "./data/model-validation.json";
import { estimateGas } from "./estimate";
describe("current-release local gas previews", () => {
    it("retains receipt provenance and exact medians for measured shapes", () => {
        for (const row of measured.rows) {
            expect(estimateGas(row.shape as never)).toMatchObject({
                available: true,
                source: "benchmark",
                gasUnits: BigInt(row.gasUnits),
                protocolCommit: measured.protocolCommit,
            });
        }
    });
    it("predicts held-out shapes within the calibrated tolerance", () => {
        for (const row of validation.cases) {
            const value = estimateGas({ ...row.shape, extraDeliveryBytes: 1 } as never);
            expect(value).toMatchObject({
                available: true,
                source: "benchmark",
                statistic: "estimate",
            });
            if (value.available)
                expect(
                    Math.abs((Number(value.gasUnits) - 32) / row.measuredGas - 1)
                ).toBeLessThanOrEqual(0.15);
        }
    });
    it("models payload, Permit and signature cost rather than dropping the preview", () => {
        const query = { kind: "shield", noteOutputs: 1 };
        const base = estimateGas(query),
            extra = estimateGas({
                ...query,
                extraDeliveryBytes: 1000,
                permit: true,
                fundingSignature: true,
            });
        expect(extra).toMatchObject({ available: true, source: "benchmark" });
        if (base.available && extra.available)
            expect(extra.gasUnits).toBeGreaterThan(base.gasUnits);
    });
    it("accounts for public per-delivery byte-size fields", () => {
        const query = {
            kind: "transact",
            capacity: 3,
            noteInputs: 1,
            noteOutputs: 2,
            scenario: "private",
        };
        const base = estimateGas(query),
            extra = estimateGas({ ...query, noteCiphertextBytes: 300, clueBytes: 100 });
        expect(extra).toMatchObject({ source: "benchmark", available: true });
        if (base.available && extra.available)
            expect(extra.gasUnits).toBeGreaterThan(base.gasUnits);
    });
    it("rejects illegal counts rather than returning zero", () => {
        for (const q of [
            { kind: "shield", noteOutputs: 0 },
            { kind: "shield", noteOutputs: 11 },
            { kind: "transact", noteInputs: 0, noteOutputs: 1, deposit: true },
            { kind: "draw-credit", creditInputs: 81 },
        ])
            expect(() => estimateGas(q)).toThrow();
    });
    it("keeps unsupported aggregate previews explicitly separate", () => {
        expect(estimateGas({ kind: "aggregate" })).toMatchObject({ available: false });
    });
});
