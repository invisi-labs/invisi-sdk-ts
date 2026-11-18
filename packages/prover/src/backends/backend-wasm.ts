import type { Barretenberg as BBApi } from "@aztec-foundation/bb.js";
import type {
    CircuitName,
    CompiledCircuit,
    ProofBundle,
    ProofTarget,
} from "../circuits/circuit-types";
import { loadVerificationKeyBrowser } from "../circuits/circuits-browser";
import {
    assertProofBundle,
    authenticateCircuit,
    fromHex,
    makeProofBundle,
    toHex,
} from "../proofs/proof-data";
import type { ResourceOptions } from "../resources/loader";
import { wasmSrsSize } from "./wasm-srs";
export interface WasmOptions {
    resources?: ResourceOptions;
    signal?: AbortSignal;
    threads?: number;
    wasmPath?: string;
    crsPath?: string;
}
function settings(target: ProofTarget) {
    return {
        ipaAccumulation: false,
        oracleHashType: target === "evm" ? "keccak" : "poseidon2",
        disableZk: false,
        optimizedSolidityVerifier: false,
    };
}
async function runtime(key: Uint8Array, options: WasmOptions): Promise<BBApi> {
    const { Barretenberg, BackendType } = await import("@aztec-foundation/bb.js");
    return Barretenberg.new({
        backend: BackendType.WasmWorker,
        threads: options.threads ?? 4,
        srsSize: wasmSrsSize(key),
        ...(options.wasmPath === undefined ? {} : { wasmPath: options.wasmPath }),
        ...(options.crsPath === undefined ? {} : { crsPath: options.crsPath }),
    });
}
function fields(bytes: Uint8Array): Uint8Array[] {
    return Array.from({ length: bytes.length / 32 }, (_, i) => bytes.slice(i * 32, (i + 1) * 32));
}
export async function verifyWithWasm(
    bundle: ProofBundle,
    options: WasmOptions = {}
): Promise<boolean> {
    await assertProofBundle(bundle);
    const key = await loadVerificationKeyBrowser(
            bundle.circuitName,
            bundle.target,
            options.resources,
            options.signal
        ),
        api = await runtime(key, options);
    try {
        const { verified } = await api.circuitVerify({
            verificationKey: key,
            publicInputs: bundle.publicInputs.map(fromHex),
            proof: fields(fromHex(bundle.proofHex)),
            settings: settings(bundle.target),
        });
        if (!verified) throw new Error("Independent WASM proof verification failed");
        return true;
    } finally {
        await api.destroy();
    }
}
export async function proveWithWasm(
    params: WasmOptions & {
        circuitName: CircuitName;
        circuit: CompiledCircuit;
        witness: Uint8Array;
        target?: ProofTarget;
        expectedPublicInputs?: readonly string[];
    }
): Promise<ProofBundle> {
    const target = params.target ?? "evm";
    await authenticateCircuit(params.circuitName, params.circuit);
    const key = await loadVerificationKeyBrowser(
        params.circuitName,
        target,
        params.resources,
        params.signal
    );
    const api = await runtime(key, params);
    let raw: Uint8Array | undefined;
    try {
        // 6.0.0 circuitProve accepts uncompressed witness and ACIR, with the released VK.
        // Use the released VK directly rather than regenerating a key.
        const compressedAcir = Uint8Array.from(atob(params.circuit.bytecode), (value) =>
            value.charCodeAt(0)
        );
        const acir = new Uint8Array(
            await new Response(
                new Blob([compressedAcir]).stream().pipeThrough(new DecompressionStream("gzip"))
            ).arrayBuffer()
        );
        raw = new Uint8Array(
            await new Response(
                new Blob([new Uint8Array(params.witness)])
                    .stream()
                    .pipeThrough(new DecompressionStream("gzip"))
            ).arrayBuffer()
        );
        const result = await api.circuitProve({
            witness: raw,
            circuit: { name: params.circuitName, bytecode: acir, verificationKey: key },
            settings: settings(target),
        });
        const proofBytes = new Uint8Array(result.proof.length * 32);
        result.proof.forEach((field, i) => proofBytes.set(field, i * 32));
        const bundle = await makeProofBundle(
            params.circuitName,
            target,
            toHex(proofBytes),
            result.publicInputs.map(toHex),
            params.expectedPublicInputs
        );
        const { verified } = await api.circuitVerify({
            verificationKey: key,
            publicInputs: result.publicInputs,
            proof: result.proof,
            settings: settings(target),
        });
        if (!verified) throw new Error("Independent WASM proof verification failed");
        return bundle;
    } finally {
        raw?.fill(0);
        await api.destroy();
    }
}
