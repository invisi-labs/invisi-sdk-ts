export { generateProof, generateProofBundle, verifyProofBundle } from "./prover";
export type { ProveParams, Backend } from "./prover";
export { checkBBAvailable, proveWithBB, verifyWithBB } from "./backend-bb";
export type { NativeOptions } from "./backend-bb";
export { proveWithWasm, verifyWithWasm } from "./backend-wasm";
export type { WasmOptions } from "./backend-wasm";
export {
    loadCircuit,
    getCircuitPath,
    getVerificationKeyPath,
    loadVerificationKey,
    CIRCUIT_NAMES,
} from "./circuits";
export {
    getCircuitMetadata,
    getCircuitKey,
    assertProofBundle,
    aggregateCircuitPublicInputs,
} from "./proof-data";
export type {
    CircuitName,
    CompiledCircuit,
    ProofTarget,
    ProofBundle,
    CircuitMetadata,
    Hex,
} from "./circuit-types";
export { generateWitness } from "./witness";

import { BackendProver } from "./backend-service";
import { generateProofBundle as proveNative, verifyProofBundle as verifyNative } from "./prover";
import type { NativeOptions as NativeConfiguration } from "./backend-bb";
import type { ProvingRequest, ProverOptions } from "./interfaces";
import type { ProofBundle as NativeBundle } from "./circuit-types";
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
