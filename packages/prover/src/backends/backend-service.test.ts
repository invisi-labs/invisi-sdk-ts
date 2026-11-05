import { expect, it } from "vitest";
import { LocalWitness, type ProvingRequest } from "../interfaces";
import { NativeProver } from "../native";
import { getCircuitKey, getCircuitMetadata } from "../proofs/proof-data";
import { CANCEL_FIXTURE } from "../testing/test-fixtures";
import { WasmProver } from "../wasm";
const statement = (): ProvingRequest => ({
    circuitName: "credit_cancel",
    target: "evm",
    artifactSha256: getCircuitMetadata("credit_cancel").artifactSha256,
    vkSha256: getCircuitKey("credit_cancel").vkSha256,
    expectedPublicInputs: [...CANCEL_FIXTURE.publicInputs],
    witness: new LocalWitness(CANCEL_FIXTURE.witness),
});
it("rejects stale releases and cancellation before executing a backend", async () => {
    for (const prover of [
        new NativeProver({ bbBin: "/nonexistent-no-execution" }),
        new WasmProver(),
    ]) {
        await expect(prover.prove({ ...statement(), vkSha256: "0".repeat(64) })).rejects.toThrow(
            /release/i
        );
        const controller = new AbortController();
        controller.abort();
        await expect(prover.prove(statement(), { signal: controller.signal })).rejects.toThrow();
    }
});
const real = process.env.BB_BINARY_PATH ? it : it.skip;
real(
    "runs explicit native and WASM services with independent verification and frozen statements",
    async () => {
        const request = statement(),
            native = new NativeProver({ bbBin: process.env.BB_BINARY_PATH!, threads: 4 });
        const phases: string[] = [],
            proof = await native.prove(request, { onProgress: (p) => phases.push(p.phase) });
        expect(phases).toEqual(["witness", "proving", "verifying", "complete"]);
        expect(await native.verify(proof, request)).toBe(true);
        const changed = { ...request, expectedPublicInputs: [...request.expectedPublicInputs] };
        changed.expectedPublicInputs[0] = ("0x" + "00".repeat(32)) as `0x${string}`;
        await expect(native.verify(proof, changed)).rejects.toThrow(/statement/i);
        if (process.env.INVISI_TEST_WASM === "1") {
            const wasm = new WasmProver({ threads: 4 }),
                wasmProof = await wasm.prove(request);
            expect(await native.verify(wasmProof, request)).toBe(true);
            expect(await wasm.verify(proof, request)).toBe(true);
        }
    },
    600_000
);

import type { ProofBundle } from "../circuits/circuit-types";
import { BackendProver } from "./backend-service";
it("does not disclose private backend diagnostics through public service errors", async () => {
    class FaultyBackend extends BackendProver {
        protected async execute(): Promise<ProofBundle> {
            throw new Error("private-nullifier-key=123456789");
        }
        protected async verifyBundle(): Promise<boolean> {
            return true;
        }
    }
    await expect(new FaultyBackend().prove(statement())).rejects.toThrow(
        "Local proof execution failed"
    );
});
