import { proveWithWasm, verifyWithWasm, type WasmOptions } from "./backends/backend-wasm";
import type { CircuitName, Hex, ProofBundle, ProofTarget } from "./circuits/circuit-types";
import { loadCircuitBrowser } from "./circuits/circuits-browser";
import { getCircuitKey } from "./proofs/proof-data";
import { generateWitness } from "./witness/witness";
export interface ProveBrowserParams extends WasmOptions {
    circuitName: CircuitName;
    inputs: Record<string, unknown>;
    target?: ProofTarget;
    expectedPublicInputs?: readonly string[];
}
export async function generateProofBundle(params: ProveBrowserParams): Promise<ProofBundle> {
    getCircuitKey(params.circuitName, params.target ?? "evm");
    const circuit = await loadCircuitBrowser(params.circuitName),
        witness = await generateWitness(circuit, params.inputs);
    try {
        return await proveWithWasm({ ...params, circuit, witness });
    } finally {
        witness.fill(0);
    }
}
export async function generateProof(params: ProveBrowserParams): Promise<Hex> {
    return (await generateProofBundle(params)).proofHex;
}
export { proveWithWasm, verifyWithWasm as verifyProofBundle } from "./backends/backend-wasm";
export type { WasmOptions } from "./backends/backend-wasm";
export { CIRCUIT_NAMES } from "./circuits/circuit-types";
export type {
    CircuitMetadata,
    CircuitName,
    CompiledCircuit,
    Hex,
    ProofBundle,
    ProofTarget,
} from "./circuits/circuit-types";
export { loadCircuitBrowser, loadVerificationKeyBrowser } from "./circuits/circuits-browser";
export {
    aggregateCircuitPublicInputs,
    assertProofBundle,
    getCircuitKey,
    getCircuitMetadata,
} from "./proofs/proof-data";
export { generateWitness } from "./witness/witness";

import { BackendProver } from "./backends/backend-service";
import type { ProverOptions, ProvingRequest } from "./interfaces";
/** Explicit in-process WASM proving. Cancellation discards results between phases. */
export class WasmProver extends BackendProver {
    readonly #options: WasmOptions;
    constructor(options: WasmOptions = {}) {
        super();
        this.#options = Object.freeze({ ...options });
    }
    protected execute(request: ProvingRequest, options: ProverOptions): Promise<ProofBundle> {
        options.signal?.throwIfAborted();
        options.onProgress?.({ phase: "proving" });
        return request.witness.withInputs((inputs) =>
            generateProofBundle({
                ...this.#options,
                circuitName: request.circuitName,
                target: request.target,
                expectedPublicInputs: request.expectedPublicInputs,
                inputs,
            })
        );
    }
    protected verifyBundle(bundle: ProofBundle, options: ProverOptions) {
        options.signal?.throwIfAborted();
        return verifyWithWasm(bundle, this.#options);
    }
}
