import { describe, expect, it } from "vitest";
import { loadCircuit, loadVerificationKey } from "./circuits/circuits";
import {
    CIRCUIT_NAMES,
    generateProofBundle,
    loadCircuitBrowser,
    loadVerificationKeyBrowser,
} from "./wasm";
describe("browser assets", () => {
    it.each(CIRCUIT_NAMES)("matches authenticated Node assets for %s", async (name) => {
        expect(await loadCircuitBrowser(name)).toEqual(loadCircuit(name));
        expect(await loadVerificationKeyBrowser(name)).toEqual(
            new Uint8Array(loadVerificationKey(name))
        );
    });
    it("rejects unpublished recursion before witness execution", async () => {
        await expect(
            generateProofBundle({
                circuitName: "credit_update",
                inputs: {},
                target: "noir-recursive",
            })
        ).rejects.toThrow("Unsupported");
    });
});
