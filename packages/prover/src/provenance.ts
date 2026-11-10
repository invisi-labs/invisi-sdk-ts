import { hexlify, sha256 } from "ethers";
import { Noir } from "@noir-lang/noir_js";
import type { CompiledCircuit } from "@noir-lang/noir_js";
import { authenticateManifest, witnessJSON } from "./provenance-witness";
import { PUBLIC_INPUTS, word } from "@invisi-labs/protocol/provenance";
import type { OfflineProver, Witness } from "./provenance-witness";
import type { ManifestIdentity } from "@invisi-labs/protocol/provenance";

export interface ProvenanceAssets {
    manifest: Uint8Array;
    artifact: Uint8Array;
    verificationKey: Uint8Array;
}
export interface LocalProvenanceOptions {
    trustedManifestSha256: string;
    loadAssets: (capacity: number) => Promise<ProvenanceAssets>;
    threads?: number;
    wasmPath?: string;
    crsPath?: string;
    signal?: AbortSignal;
}
const digest = (bytes: Uint8Array): string => sha256(bytes).slice(2);
async function decompress(bytes: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(
        await new Response(
            new Blob([new Uint8Array(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"))
        ).arrayBuffer()
    );
}
const settings = {
    ipaAccumulation: false,
    oracleHashType: "keccak",
    disableZk: false,
    optimizedSolidityVerifier: false,
};

/** The host supplies local public assets; private witness stays in the in-process Noir/BB runtime. */
export class LocalProvenanceProver implements OfflineProver {
    constructor(private readonly options: LocalProvenanceOptions) {}
    async prove(request: {
        identity: ManifestIdentity;
        capacity: number;
        witness: Witness;
        expectedPublicInputs: readonly string[];
    }): Promise<{ proof: string; publicInputs: string[] }> {
        this.options.signal?.throwIfAborted();
        if (request.identity.sha256 !== this.options.trustedManifestSha256)
            throw new Error("Provenance manifest mismatch");
        const assets = await this.options.loadAssets(request.capacity),
            identity = authenticateManifest(assets.manifest, this.options.trustedManifestSha256),
            entry = identity.manifest.circuits.find((e) => e.capacity === request.capacity);
        if (
            !entry ||
            digest(assets.artifact) !== entry.artifactSha256 ||
            digest(assets.verificationKey) !== entry.vkSha256
        )
            throw new Error("Provenance artifact identity mismatch");
        const manifest = JSON.parse(new TextDecoder().decode(assets.manifest)) as {
            noirVersion: string;
            bbVersion: string;
            depth: number;
        };
        if (
            manifest.noirVersion !== "1.0.0" ||
            manifest.bbVersion !== "6.0.0" ||
            manifest.depth !== 32
        )
            throw new Error("Unsupported provenance runtime");
        const circuit = JSON.parse(new TextDecoder().decode(assets.artifact)) as CompiledCircuit;
        const expected = PUBLIC_INPUTS.map((k) => word(request.witness[k] as bigint));
        if (JSON.stringify(expected) !== JSON.stringify(request.expectedPublicInputs))
            throw new Error("Witness statement mismatch");
        const noir = new Noir(circuit),
            executed = await noir.execute(JSON.parse(witnessJSON(request.witness)));
        let raw: Uint8Array | undefined;
        let api: import("@aztec-foundation/bb.js").Barretenberg | undefined;
        try {
            raw = await decompress(executed.witness);
            this.options.signal?.throwIfAborted();
            const { Barretenberg, BackendType } = await import("@aztec-foundation/bb.js");
            const logN = Number(BigInt(hexlify(assets.verificationKey.slice(0, 32))));
            if (!Number.isInteger(logN) || logN < 1 || logN > 28)
                throw new Error("Invalid provenance VK size");
            api = await Barretenberg.new({
                backend: BackendType.WasmWorker,
                threads: this.options.threads ?? 4,
                srsSize: 2 ** logN + 1,
                ...(this.options.wasmPath ? { wasmPath: this.options.wasmPath } : {}),
                ...(this.options.crsPath ? { crsPath: this.options.crsPath } : {}),
            });
            const compressed = Uint8Array.from(atob(circuit.bytecode), (c) => c.charCodeAt(0));
            const result = await api.circuitProve({
                witness: raw,
                circuit: {
                    name: `provenance_k${request.capacity}`,
                    bytecode: await decompress(compressed),
                    verificationKey: assets.verificationKey,
                },
                settings,
            });
            const publicInputs = result.publicInputs.map((v) => hexlify(v));
            if (publicInputs.length !== 11 || publicInputs.some((v, i) => v !== expected[i]))
                throw new Error("Provenance statement mismatch");
            const checked = await api.circuitVerify({
                verificationKey: assets.verificationKey,
                publicInputs: result.publicInputs,
                proof: result.proof,
                settings,
            });
            if (!checked.verified) throw new Error("Independent provenance verification failed");
            this.options.signal?.throwIfAborted();
            const bytes = new Uint8Array(result.proof.length * 32);
            result.proof.forEach((v, i) => bytes.set(v, i * 32));
            return { proof: hexlify(bytes), publicInputs };
        } finally {
            raw?.fill(0);
            executed.witness.fill(0);
            await api?.destroy();
        }
    }
}
