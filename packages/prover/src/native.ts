import type { ProvenanceProvider } from "./provenance-witness";
export { checkBBAvailable, proveWithBB, verifyWithBB } from "./backends/backend-bb";
export type { NativeOptions } from "./backends/backend-bb";
export { proveWithWasm, verifyWithWasm } from "./backends/backend-wasm-node";
export type { WasmOptions } from "./backends/backend-wasm-node";
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
    loadCircuitAsync,
    loadVerificationKeyAsync,
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

import {
    NativeProvenanceBackend,
    type NativeProvenanceAssetsOptions,
} from "./backends/provenance-native";
import type { NativeOptions as NativeConfiguration } from "./backends/backend-bb";
import { BackendProver } from "./backends/backend-service";
import type { ProofBundle as NativeBundle } from "./circuits/circuit-types";
import type { ProverOptions, ProvingRequest } from "./interfaces";
import {
    generateProofBundle as proveNative,
    verifyProofBundle as verifyNative,
} from "./proofs/prover";
export interface NativeProverOptions extends NativeProvenanceAssetsOptions {}
/** Explicit native proving. It never falls back to another process or service. */
export class NativeProver extends BackendProver implements ProvenanceProvider {
    readonly #sourceBackend: NativeProvenanceBackend;
    readonly #options: NativeConfiguration;
    constructor(options: NativeProverOptions = {}) {
        super();
        this.#options = Object.freeze({ ...options });
        this.#sourceBackend = new NativeProvenanceBackend(Object.freeze({ ...options }));
    }
    async getProvenanceCapability() {
        return { manifest: await this.#sourceBackend.manifest(), prover: this.#sourceBackend };
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

export type { NodeResourceOptions } from "./resources/node";
export type { ResourceCache } from "./resources/loader";
export { PROVER_ASSET_INDEX_SHA256 } from "./resources/pin";
