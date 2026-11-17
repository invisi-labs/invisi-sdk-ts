import { proveWithBB, verifyWithBB, type NativeOptions } from "../backends/backend-bb";
import { proveWithWasm, verifyWithWasm, type WasmOptions } from "../backends/backend-wasm-node";
import type { CircuitName, Hex, ProofBundle, ProofTarget } from "../circuits/circuit-types";
import { loadCircuitAsync } from "../circuits/circuits";
import { generateWitness } from "../witness/witness";
import { getCircuitKey } from "./proof-data";
export type Backend = "bb" | "wasm";
export interface ProveParams extends NativeOptions, Omit<WasmOptions, "resources"> {
    circuitName: CircuitName;
    inputs: Record<string, unknown>;
    backend?: Backend;
    target?: ProofTarget;
    expectedPublicInputs?: readonly string[];
}
export async function generateProofBundle(params: ProveParams): Promise<ProofBundle> {
    getCircuitKey(params.circuitName, params.target ?? "evm");
    const circuit = await loadCircuitAsync(params.circuitName, params.resources, params.signal),
        witness = await generateWitness(circuit, params.inputs);
    try {
        if ((params.backend ?? "bb") === "bb") return await proveWithBB({ ...params, witness });
        return await proveWithWasm({ ...params, circuit, witness });
    } finally {
        witness.fill(0);
    }
}
/** Raw proof convenience. Use generateProofBundle to retain its public statement and release identity. */
export async function generateProof(params: ProveParams): Promise<Hex> {
    return (await generateProofBundle(params)).proofHex;
}
export async function verifyProofBundle(
    bundle: ProofBundle,
    options: NativeOptions & WasmOptions & { backend?: Backend } = {}
): Promise<boolean> {
    return options.backend === "wasm"
        ? verifyWithWasm(bundle, options)
        : verifyWithBB(bundle, options);
}
