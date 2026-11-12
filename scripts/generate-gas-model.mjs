/** Refresh local preview coefficients from successful, snapshot-isolated current-release receipts. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const paths = process.argv.slice(2);
assert(paths.length === 3, "Supply the completed Note, Credit and control receipt reports");
const reports = paths.map((path) => JSON.parse(readFileSync(path, "utf8")));
assert(
    reports.every((r) => r.commit === reports[0].commit),
    "Mixed protocol revisions"
);
const rows = reports.flatMap((report) => report.rows);
for (const row of rows)
    if (
        row.shape.kind === "draw-credit" &&
        row.shape.creditInputs === 5 &&
        row.shape.distinctPayers === 1
    )
        row.shape.validation = true;
for (const row of rows) {
    if (row.shape.kind === "shield") row.shape.fee ??= false;
    assert.equal(row.samples.length, 3);
    assert(row.samples.every((value) => Number.isSafeInteger(value) && value > 0));
    assert.equal([...row.samples].sort((a, b) => a - b)[1], row.gasUnits);
}
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
const creditCapacities = [1, 2, 3, 4, 5, 10, 20, 30, 40, 50, 60, 70, 80];
const shapeKey = (shape) =>
    JSON.stringify(
        Object.entries(shape)
            .filter(([key]) => key !== "validation")
            .sort(([a], [b]) => a.localeCompare(b))
    );
const withheld = new Set(rows.filter((r) => r.shape.validation).map((r) => shapeKey(r.shape)));
for (const row of rows) if (withheld.has(shapeKey(row.shape))) row.shape.validation = true;
for (let n = 1; n <= 10; n++)
    for (const fee of [false, true])
        assert(
            rows.some(
                (r) => r.shape.kind === "shield" && r.shape.noteOutputs === n && r.shape.fee === fee
            ),
            "Missing Shield fee/output coverage"
        );
for (const kind of ["create-credit", "update-credit"])
    for (const fee of [false, true])
        assert(
            rows.some((r) => r.shape.kind === kind && r.shape.fee === fee),
            "Missing lifecycle fee coverage"
        );
for (const authorization of ["direct", "eoa"])
    for (const fee of [false, true])
        assert(
            rows.some(
                (r) =>
                    r.shape.kind === "revoke-credit" &&
                    r.shape.authorization === authorization &&
                    r.shape.fee === fee &&
                    r.shape.bitmapWord === "empty"
            ),
            "Missing revocation fee/authorization coverage"
        );
for (const [i, c] of creditCapacities.entries())
    for (const n of [c, (creditCapacities[i - 1] ?? 0) + 1])
        for (const fee of [false, true])
            assert(
                rows.some(
                    (r) =>
                        r.shape.kind === "draw-credit" &&
                        r.shape.capacity === c &&
                        r.shape.creditInputs === n &&
                        r.shape.distinctPayers === n &&
                        r.shape.fee === fee
                ),
                "Missing draw capacity endpoint"
            );
// Ridge stabilizes the intercepts without making sparse routing classes interchangeable.
function fit(samples, features) {
    const xs = samples.map((r) => features(r.shape)),
        size = xs[0].length;
    const matrix = Array.from({ length: size }, (_, i) =>
        Array.from({ length: size + 1 }, (_, j) =>
            j === size
                ? xs.reduce((sum, x, k) => sum + x[i] * samples[k].gasUnits, 0)
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
    return matrix.map((row) => Math.round(row[size] * 1000) / 1000);
}
const transact = (s) => [
    ...capacities.map((c) => Number(c === s.capacity)),
    s.noteInputs,
    s.noteOutputs,
    Number(s.noteOutputs > 0),
    Number(s.deposit),
    Number(s.withdrawal),
    Number(s.fee),
];
const draw = (s) => [
    ...creditCapacities.map((c) => Number(c === s.capacity)),
    s.creditInputs,
    s.distinctPayers,
    Number(s.fee),
];
const transactRows = rows.filter((r) => r.shape.kind === "transact" && !r.shape.validation);
const drawRows = rows.filter((r) => r.shape.kind === "draw-credit" && !r.shape.validation);
assert(
    capacities.every((c) => transactRows.some((r) => r.shape.capacity === c)),
    "Missing transact capacity"
);
assert(
    creditCapacities.every((c) => drawRows.some((r) => r.shape.capacity === c)),
    "Missing draw capacity"
);
assert.equal(rows.filter((r) => r.shape.kind === "shield" && !r.shape.fee).length, 10);
const coefficients = { transact: fit(transactRows, transact), draw: fit(drawRows, draw) };
const validation = rows
    .filter(
        (r, i) =>
            r.shape.validation &&
            rows.findIndex((other) => shapeKey(other.shape) === shapeKey(r.shape)) === i
    )
    .map((row) => {
        const family = row.shape.kind === "draw-credit" ? "draw" : "transact";
        const features = family === "draw" ? draw(row.shape) : transact(row.shape);
        const value = features.reduce((sum, x, i) => sum + x * coefficients[family][i], 0);
        return {
            shape: row.shape,
            measuredGas: row.gasUnits,
            modeledGas: Math.round(value),
            errorPercent: Math.round((value / row.gasUnits - 1) * 10000) / 100,
        };
    });
assert(validation.length >= 10, "Missing independent shape validation");
assert(
    validation.every((v) => Math.abs(v.errorPercent) <= 15),
    "Model exceeds 15% held-out tolerance"
);
const result = {
    formatVersion: 1,
    sourceSha256: createHash("sha256")
        .update(
            paths.map((p) => createHash("sha256").update(readFileSync(p)).digest("hex")).join("\n")
        )
        .digest("hex"),
    protocolCommit: reports[0].commit,
    environment: reports[0].environment,
    reportSha256: paths.map((p) => createHash("sha256").update(readFileSync(p)).digest("hex")),
    capacities,
    creditCapacities,
    coefficients,
    validation,
    rows,
};
const references = [...new Map(rows.map((row) => [shapeKey(row.shape), row])).keys()].map((key) => {
    const row = rows.find((row) => shapeKey(row.shape) === key);
    return {
        shape: Object.fromEntries(
            Object.entries(row.shape).filter(([key]) => key !== "validation")
        ),
        gasUnits: row.gasUnits,
    };
});
const { environment, reportSha256, validation: cases, rows: observations, ...runtime } = result;
writeFileSync(
    "packages/protocol/src/gas/data/measured-model.json",
    JSON.stringify({ ...runtime, rows: references }, null, 2) + "\n"
);
writeFileSync(
    "packages/protocol/src/gas/data/model-validation.json",
    JSON.stringify(
        {
            protocolCommit: result.protocolCommit,
            environment,
            reportSha256,
            measuredScenarioCount: observations.length,
            cases,
        },
        null,
        2
    ) + "\n"
);
console.log(JSON.stringify({ rows: rows.length, validation }, null, 2));
