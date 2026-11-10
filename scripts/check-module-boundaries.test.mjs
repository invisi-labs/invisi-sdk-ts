import { test } from "node:test";
import assert from "node:assert/strict";
import { checkModuleBoundaries, validateDependency } from "./check-module-boundaries.mjs";
test(
    "actual package manifests and runtime imports follow the six-module DAG",
    checkModuleBoundaries
);
test("rejects cross-layer dependencies even if they are type-only", () => {
    for (const [owner, target] of [
        ["primitives", "prover"],
        ["protocol", "rpc"],
        ["prover", "rpc"],
        ["rpc", "prover"],
        ["sdk", "session"],
        ["session", "prover"],
    ])
        assert.throws(() => validateDependency(owner, target, "fixture"), /forbidden/);
    validateDependency("session", "protocol", "public DTOs");
});
