/** Refresh only Credit draw calibration without relabeling earlier Note measurements. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const path = process.argv[2];
assert(path, "Supply a completed measure-credit.mjs report");
const raw = readFileSync(path),
    report = JSON.parse(raw);
const modelPath = "packages/protocol/src/gas/data/measured-model.json";
const validationPath = "packages/protocol/src/gas/data/model-validation.json";
const model = JSON.parse(readFileSync(modelPath));
const validation = JSON.parse(readFileSync(validationPath));
const rows = report.rows.filter((r) => r.shape.kind === "draw-credit");
assert(report.sourceSha256 && report.samples === 3);
for (const row of rows) {
    assert.equal(row.samples.length, 3);
    assert(row.samples.every((v) => Number.isSafeInteger(v) && v > 0));
    assert.equal([...row.samples].sort((a, b) => a - b)[1], row.gasUnits);
    if (row.shape.creditInputs === 5 && row.shape.distinctPayers === 1) row.shape.validation = true;
}
const capacities = model.creditCapacities;
for (const [i, c] of capacities.entries())
    for (const n of [c, (capacities[i - 1] ?? 0) + 1])
        for (const fee of [false, true])
            assert(
                rows.some(
                    (r) =>
                        r.shape.capacity === c &&
                        r.shape.creditInputs === n &&
                        r.shape.distinctPayers === n &&
                        r.shape.fee === fee
                ),
                "Missing draw capacity endpoint"
            );
const features = (s) => [
    ...capacities.map((c) => Number(c === s.capacity)),
    s.creditInputs,
    s.distinctPayers,
    Number(s.fee),
];
const training = rows.filter((r) => !r.shape.validation),
    xs = training.map((r) => features(r.shape)),
    size = xs[0].length;
const matrix = Array.from({ length: size }, (_, i) =>
    Array.from({ length: size + 1 }, (_, j) =>
        j === size
            ? xs.reduce((sum, x, k) => sum + x[i] * training[k].gasUnits, 0)
            : xs.reduce((sum, x) => sum + x[i] * x[j], 0) + (i === j ? 1e-8 : 0)
    )
);
for (let column = 0; column < size; column++) {
    let pivot = column;
    for (let r = column + 1; r < size; r++)
        if (Math.abs(matrix[r][column]) > Math.abs(matrix[pivot][column])) pivot = r;
    [matrix[pivot], matrix[column]] = [matrix[column], matrix[pivot]];
    const divisor = matrix[column][column];
    assert(Math.abs(divisor) > 1e-12, "Singular calibration");
    for (let j = column; j <= size; j++) matrix[column][j] /= divisor;
    for (let r = 0; r < size; r++)
        if (r !== column) {
            const multiple = matrix[r][column];
            for (let j = column; j <= size; j++) matrix[r][j] -= multiple * matrix[column][j];
        }
}
const coefficients = matrix.map((row) => Math.round(row[size] * 1000) / 1000);
const cases = rows
    .filter((r) => r.shape.validation)
    .map((row) => {
        const value = features(row.shape).reduce((sum, x, i) => sum + x * coefficients[i], 0);
        return {
            shape: row.shape,
            measuredGas: row.gasUnits,
            modeledGas: Math.round(value),
            errorPercent: Math.round((value / row.gasUnits - 1) * 10000) / 100,
        };
    });
assert(
    cases.length >= 2 && cases.every((v) => Math.abs(v.errorPercent) <= 15),
    "Model exceeds held-out tolerance"
);
const identity = {
    protocolCommit: report.commit,
    sourceSha256: report.sourceSha256,
    sourceState: report.sourceState,
    reportSha256: createHash("sha256").update(raw).digest("hex"),
    conditions: report.conditions,
    sampleCount: 3,
};
model.creditDrawMeasurement = identity;
model.coefficients.draw = coefficients;
model.rows = [
    ...model.rows.filter((r) => r.shape.kind !== "draw-credit"),
    ...rows.map((r) => ({
        shape: Object.fromEntries(Object.entries(r.shape).filter(([k]) => k !== "validation")),
        gasUnits: r.gasUnits,
    })),
];
validation.creditDrawMeasurement = identity;
validation.cases = [...validation.cases.filter((r) => r.shape.kind !== "draw-credit"), ...cases];
writeFileSync(modelPath, JSON.stringify(model, null, 2) + "\n");
writeFileSync(validationPath, JSON.stringify(validation, null, 2) + "\n");
console.log(
    JSON.stringify(
        { drawShapes: rows.length, receiptSamples: rows.length * 3, heldOut: cases },
        null,
        2
    )
);
