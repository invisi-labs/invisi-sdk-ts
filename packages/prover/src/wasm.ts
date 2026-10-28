import { loadCircuitBrowser } from "./circuits-browser";
import { generateWitness } from "./witness";
import { proveWithWasm, verifyWithWasm, type WasmOptions } from "./backend-wasm";
import { getCircuitKey } from "./proof-data";
import type { CircuitName, ProofBundle, ProofTarget, Hex } from "./circuit-types";
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
export { verifyWithWasm as verifyProofBundle, proveWithWasm } from "./backend-wasm";
export type { WasmOptions } from "./backend-wasm";
export { loadCircuitBrowser, loadVerificationKeyBrowser } from "./circuits-browser";
export { generateWitness } from "./witness";
export {
    getCircuitMetadata,
    getCircuitKey,
    assertProofBundle,
    aggregateCircuitPublicInputs,
} from "./proof-data";
export { CIRCUIT_NAMES } from "./circuit-types";
export type {
    CircuitName,
    CompiledCircuit,
    ProofTarget,
    ProofBundle,
    CircuitMetadata,
    Hex,
} from "./circuit-types";

import { BackendProver } from "./backend-service";
import type { ProvingRequest, ProverOptions } from "./interfaces";
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
