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

import {
    OfficialProvenanceClients,
    PROVENANCE_MANIFEST_SHA256,
    type ProvenanceClient,
    type Scope,
    type ProvenanceProvider,
} from "@invisi-labs/core/provenance";
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
export interface NativeProverOptions extends NativeProvenanceAssetsOptions {
    provenanceClient?: ProvenanceClient;
}
/** Explicit native proving. It never falls back to another process or service. */
export class NativeProver extends BackendProver implements ProvenanceProvider {
    readonly #sourceBackend: NativeProvenanceBackend;
    readonly #sourceClient: ProvenanceClient | undefined;
    readonly #official = new OfficialProvenanceClients();
    readonly #options: NativeConfiguration;
    constructor(options: NativeProverOptions = {}) {
        super();
        this.#options = Object.freeze({ ...options });
        this.#sourceBackend = new NativeProvenanceBackend(Object.freeze({ ...options }));
        this.#sourceClient = options.provenanceClient;
    }
    async getProvenanceClient(scope: Scope): Promise<ProvenanceClient> {
        const client = this.#sourceClient ?? (await this.#official.get(scope));
        if (
            BigInt(client.trust.chainId) !== BigInt(scope.chainId) ||
            BigInt(client.trust.protocolAddress) !== BigInt(scope.protocolAddress) ||
            client.trust.manifestSha256 !== PROVENANCE_MANIFEST_SHA256
        )
            throw Error("Provenance client deployment or manifest mismatch");
        return client;
    }
    async getProvenanceCapability(scope: Scope) {
        const client = await this.getProvenanceClient(scope);
        return {
            client,
            manifest: await this.#sourceBackend.manifest(),
            prover: this.#sourceBackend,
        };
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
