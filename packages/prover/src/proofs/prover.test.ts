import { describe, expect, it } from "vitest";
import { UPDATE_FIXTURE } from "../testing/test-fixtures";
import { assertProofBundle, makeProofBundle } from "./proof-data";
import { generateProofBundle } from "./prover";
describe("proof bundle validation", () => {
    it("binds bytes, current artifact, target, key, and exact statement width", async () => {
        const bundle = await makeProofBundle("credit_update", "evm", `0x${"00".repeat(32)}`, [
            ...UPDATE_FIXTURE.publicInputs,
        ]);
        const mismatchedBackend = { ...bundle };
        Object.assign(mismatchedBackend, { bbVersion: "0.0.0" });
        await expect(assertProofBundle(mismatchedBackend)).rejects.toThrow();
        await expect(
            assertProofBundle({ ...bundle, artifactSha256: "0".repeat(64) })
        ).rejects.toThrow("Stale");
        await expect(
            assertProofBundle({ ...bundle, proofHex: `0x${"01".repeat(32)}` })
        ).rejects.toThrow("bytes changed");
        await expect(assertProofBundle({ ...bundle, publicInputs: [] })).rejects.toThrow("count");
        await expect(
            makeProofBundle(
                "credit_update",
                "evm",
                bundle.proofHex,
                bundle.publicInputs,
                bundle.publicInputs.map(() => "0")
            )
        ).rejects.toThrow("expected");
    });
    it("rejects unsupported targets before witness execution", async () => {
        await expect(
            generateProofBundle({
                circuitName: "transact_user_slots190",
                target: "noir-recursive",
                inputs: {},
            })
        ).rejects.toThrow("Unsupported");
    });
    it("rejects noncanonical public inputs before backend verification", async () => {
        const modulus =
            21888242871839275222246405745257275088548364400416034343698204186575808495617n;
        const bundle = await makeProofBundle("credit_update", "evm", `0x${"00".repeat(32)}`, [
            ...UPDATE_FIXTURE.publicInputs,
        ]);
        for (const value of [modulus, modulus + 1n]) {
            const publicInputs = [...bundle.publicInputs];
            publicInputs[0] = `0x${value.toString(16).padStart(64, "0")}`;
            await expect(assertProofBundle({ ...bundle, publicInputs })).rejects.toThrow(
                "Non-canonical public input"
            );
        }
    });
});
