import { expect, it } from "vitest";
import * as entry from "./index";
it("keeps backend and raw proof execution out of the neutral entrypoint", () => {
    for (const name of [
        "proveWithBB",
        "proveWithWasm",
        "generateProof",
        "generateWitness",
        "loadCircuit",
    ])
        expect(name in entry).toBe(false);
    expect(typeof entry.LocalWitness).toBe("function");
});
it("redacts and copies local witness material", () => {
    const source = { secret: [99n, 100n] },
        witness = new entry.LocalWitness(source);
    source.secret[0] = 7n;
    expect(witness.withInputs((values) => values.secret)).toEqual([99n, 100n]);
    witness.withInputs((values) => {
        (values.secret as bigint[])[0] = 1n;
    });
    expect(witness.withInputs((values) => values.secret)).toEqual([99n, 100n]);
    expect(JSON.stringify(witness)).not.toContain("99");
});
