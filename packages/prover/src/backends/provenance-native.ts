import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { authenticateManifest, witnessJSON, type OfflineProver } from "../provenance-witness";
import {
    PROVENANCE_MANIFEST_SHA256,
    PUBLIC_INPUTS,
    word,
    type ManifestIdentity,
} from "@invisi-labs/protocol/provenance";
import type { CompiledCircuit } from "../circuits/circuit-types";
import { generateWitness } from "../witness/witness";
import { runBB, assertBBVersion, type NativeOptions } from "./backend-bb";

const moduleDirectory =
    typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
const packaged = join(moduleDirectory, "..", "provenance");
const defaultAssets = existsSync(join(packaged, "manifest.json"))
    ? packaged
    : join(moduleDirectory, "..", "..", "provenance");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export interface NativeProvenanceAssetsOptions extends NativeOptions {
    provenanceAssetsPath?: string;
}

/** Shares the native BB process configuration; this boundary never sends witness to a service. */
export class NativeProvenanceBackend implements OfflineProver {
    readonly #root: string;
    constructor(private readonly options: NativeProvenanceAssetsOptions) {
        this.#root = resolve(options.provenanceAssetsPath ?? defaultAssets);
    }
    async manifest(): Promise<ManifestIdentity> {
        return authenticateManifest(
            await readFile(join(this.#root, "manifest.json")),
            PROVENANCE_MANIFEST_SHA256
        );
    }
    private asset(relative: string): string {
        const path = resolve(this.#root, relative);
        if (!path.startsWith(this.#root + sep)) throw Error("Invalid Provenance asset path");
        return path;
    }
    async prove(request: Parameters<OfflineProver["prove"]>[0]) {
        this.options.signal?.throwIfAborted();
        const identity = await this.manifest();
        if (request.identity.sha256 !== identity.sha256)
            throw Error("Provenance manifest mismatch");
        const entry = identity.manifest.circuits.find((e) => e.capacity === request.capacity) as
            | (ManifestIdentity["manifest"]["circuits"][number] & { artifact: string; vk: string })
            | undefined;
        if (!entry) throw Error("Unsupported Provenance capacity");
        const [artifact, vk] = await Promise.all([
            readFile(this.asset(entry.artifact)),
            readFile(this.asset(entry.vk)),
        ]);
        if (digest(artifact) !== entry.artifactSha256 || digest(vk) !== entry.vkSha256)
            throw Error("Provenance artifact identity mismatch");
        const expected = PUBLIC_INPUTS.map((k) => word(request.witness[k] as bigint));
        if (JSON.stringify(expected) !== JSON.stringify(request.expectedPublicInputs))
            throw Error("Provenance witness statement mismatch");
        const bb = this.options.bbBin ?? "bb";
        await assertBBVersion(bb, this.options);
        const witness = await generateWitness(
            JSON.parse(artifact.toString()) as CompiledCircuit,
            JSON.parse(witnessJSON(request.witness))
        );
        let directory: string | undefined;
        try {
            directory = await mkdtemp(join(tmpdir(), "invisi-provenance-"));
            const circuitPath = join(directory, "circuit.json"),
                keyPath = join(directory, "vk"),
                witnessPath = join(directory, "witness.gz");
            await Promise.all([
                writeFile(circuitPath, artifact),
                writeFile(keyPath, vk),
                writeFile(witnessPath, witness),
            ]);
            await runBB(
                bb,
                [
                    "prove",
                    "-t",
                    "evm",
                    "-b",
                    circuitPath,
                    "-w",
                    witnessPath,
                    "-k",
                    keyPath,
                    "-o",
                    directory,
                    "--output_format",
                    "json",
                ],
                this.options
            );
            const proof = JSON.parse(await readFile(join(directory, "proof.json"), "utf8"));
            const inputs = JSON.parse(
                await readFile(join(directory, "public_inputs.json"), "utf8")
            );
            if (
                proof.bb_version !== "6.0.0" ||
                proof.scheme !== "ultra_honk" ||
                !Array.isArray(proof.proof) ||
                !Array.isArray(inputs.public_inputs)
            )
                throw Error("Unsupported native Provenance proof output");
            const publicInputs = inputs.public_inputs.map((v: string) => word(v));
            if (JSON.stringify(publicInputs) !== JSON.stringify(expected))
                throw Error("Native Provenance statement mismatch");
            const proofHex = "0x" + proof.proof.map((v: string) => word(v).slice(2)).join("");
            const proofPath = join(directory, "proof"),
                inputsPath = join(directory, "public_inputs");
            await Promise.all([
                writeFile(proofPath, Buffer.from(proofHex.slice(2), "hex")),
                writeFile(
                    inputsPath,
                    Buffer.concat(publicInputs.map((v: string) => Buffer.from(v.slice(2), "hex")))
                ),
            ]);
            const verified = await runBB(
                bb,
                ["verify", "-t", "evm", "-k", keyPath, "-p", proofPath, "-i", inputsPath],
                this.options
            );
            if (!/Proof verified successfully/.test(verified.stdout + verified.stderr))
                throw Error("Independent native Provenance verification failed");
            return { proof: proofHex, publicInputs };
        } finally {
            witness.fill(0);
            if (directory) await rm(directory, { recursive: true, force: true });
        }
    }
}
