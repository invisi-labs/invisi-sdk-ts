import { describe, expect, it } from "vitest";
import { estimateGas } from "./estimate";
const capacities = [
    1,
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    9,
    10,
    ...Array.from({ length: 18 }, (_, i) => (i + 2) * 10),
];
function positive(query: Parameters<typeof estimateGas>[0]) {
    const value = estimateGas(query);
    expect(value.available, JSON.stringify(query)).toBe(true);
    if (value.available) expect(value.gasUnits).toBeGreaterThan(0n);
}
describe("complete pre-proof local gas previews", () => {
    it("covers every Shield output count", () => {
        for (let noteOutputs = 1; noteOutputs <= 10; noteOutputs++)
            positive({ kind: "shield", noteOutputs });
    });
    it("covers all canonical transact input/output counts and public flow combinations", () => {
        for (let n = 1; n <= 190; n++)
            for (let noteInputs = 0; noteInputs <= n; noteInputs++) {
                const noteOutputs = n - noteInputs;
                if (noteInputs === 0 && noteOutputs < 2) continue;
                const capacity = capacities.find((c) => c >= n)!;
                for (const deposit of [false, true])
                    for (const withdrawal of [false, true]) {
                        if (noteInputs === 0 && !deposit) continue;
                        if (noteOutputs === 0 && !withdrawal) continue;
                        for (const feeEnabled of [false, true])
                            positive({
                                kind: "transact",
                                capacity,
                                noteInputs,
                                noteOutputs,
                                deposit,
                                withdrawal,
                                feeEnabled,
                            });
                    }
            }
    }, 30_000);
    it("covers every possible payer count, extra roots and payload", () => {
        const tiers = [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80];
        for (let n = 1; n <= 80; n++)
            for (let payers = 1; payers <= n; payers++)
                positive({
                    kind: "draw-credit",
                    capacity: tiers.find((c) => c >= n)!,
                    creditInputs: n,
                    distinctPayers: payers,
                    sourceTrees: n,
                    feeEnabled: true,
                    extraDeliveryBytes: 1000,
                });
        positive({
            kind: "transact",
            capacity: 3,
            noteInputs: 2,
            noteOutputs: 1,
            sourceTrees: 2,
            deposit: true,
            withdrawal: true,
            feeEnabled: true,
            extraDeliveryBytes: 1000,
            permit: true,
            fundingSignature: true,
        });
        for (const authorization of ["direct", "eoa", "erc1271"])
            for (const bitmapWord of ["empty", "nonempty"])
                positive({ kind: "revoke-credit", authorization, bitmapWord });
    });
    it("covers all legal draw batch sizes and payer groupings", () => {
        const tiers = [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80];
        for (let n = 1; n <= 80; n++)
            for (const distinctPayers of [1, n])
                for (const feeEnabled of [false, true])
                    positive({
                        kind: "draw-credit",
                        capacity: tiers.find((c) => c >= n)!,
                        creditInputs: n,
                        distinctPayers,
                        sourceTrees: 1,
                        feeEnabled,
                    });
    });
    it("covers lifecycle fee modes without requiring caller-known storage state", () => {
        for (const kind of ["create-credit", "update-credit", "revoke-credit"])
            for (const feeEnabled of [false, true]) positive({ kind, feeEnabled });
    });
});
