export { checkBBAvailable, proveWithBB, verifyWithBB } from "./backends/backend-bb";
export type { NativeOptions } from "./backends/backend-bb";
export { proveWithWasm, verifyWithWasm } from "./backends/backend-wasm";
export type { WasmOptions } from "./backends/backend-wasm";
export type {
    CircuitMetadata,
    CircuitName,
    CompiledCircuit,
    Hex,
    ProofBundle,
    ProofTarget,
} from "./circuits/circuit-types";
export {
    CIRCUIT_NAMES,
    getCircuitPath,
    getVerificationKeyPath,
    loadCircuit,
    loadVerificationKey,
} from "./circuits/circuits";
export {
    aggregateCircuitPublicInputs,
    assertProofBundle,
    getCircuitKey,
    getCircuitMetadata,
} from "./proofs/proof-data";
export { generateProof, generateProofBundle, verifyProofBundle } from "./proofs/prover";
export type { Backend, ProveParams } from "./proofs/prover";
export { generateWitness } from "./witness/witness";

import type { NativeOptions as NativeConfiguration } from "./backends/backend-bb";
import { BackendProver } from "./backends/backend-service";
import type { ProofBundle as NativeBundle } from "./circuits/circuit-types";
import type { ProverOptions, ProvingRequest } from "./interfaces";
import {
    generateProofBundle as proveNative,
    verifyProofBundle as verifyNative,
} from "./proofs/prover";
/** Explicit native proving. It never falls back to another process or service. */
export class NativeProver extends BackendProver {
    readonly #options: NativeConfiguration;
    constructor(options: NativeConfiguration = {}) {
        super();
        this.#options = Object.freeze({ ...options });
    }
    protected execute(request: ProvingRequest, options: ProverOptions): Promise<NativeBundle> {
        options.signal?.throwIfAborted();
        options.onProgress?.({ phase: "proving" });
        return request.witness.withInputs((inputs) =>
            proveNative({
                ...this.#options,
                circuitName: request.circuitName,
                target: request.target,
                expectedPublicInputs: request.expectedPublicInputs,
                inputs,
                backend: "bb",
                ...(options.signal ? { signal: options.signal } : {}),
            })
        );
    }
    protected verifyBundle(bundle: NativeBundle, options: ProverOptions) {
        return verifyNative(bundle, {
            ...this.#options,
            backend: "bb",
            ...(options.signal ? { signal: options.signal } : {}),
        });
    }
}
