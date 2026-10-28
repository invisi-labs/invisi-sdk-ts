import { describe, it, expect } from "vitest";
import {
    loadCircuitBrowser,
    loadVerificationKeyBrowser,
    CIRCUIT_NAMES,
    generateProofBundle,
} from "./wasm";
import { loadCircuit, loadVerificationKey } from "./circuits";
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
                circuitName: "credit_cancel",
                inputs: {},
                target: "noir-recursive",
            })
        ).rejects.toThrow("Unsupported");
    });
});
