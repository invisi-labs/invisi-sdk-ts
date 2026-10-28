import { execFile } from "node:child_process";
import { writeFile, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadCircuit, loadVerificationKey } from "./circuits";
import { assertProofBundle, fieldHex, fromHex, makeProofBundle } from "./proof-data";
import type { CircuitName, ProofBundle, ProofTarget } from "./circuit-types";
const execFileAsync = promisify(execFile);
export interface NativeOptions {
    bbBin?: string;
    threads?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
}
async function run(bbBin: string, args: string[], options: NativeOptions) {
    return execFileAsync(bbBin, args, {
        timeout: options.timeoutMs ?? 600_000,
        maxBuffer: 32 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
        env: {
            ...process.env,
            BB_MSM_LEGACY: process.env.BB_MSM_LEGACY ?? "1",
            HARDWARE_CONCURRENCY: String(options.threads ?? 4),
        },
    });
}
async function assertVersion(bbBin: string, options: NativeOptions): Promise<void> {
    const result = await run(bbBin, ["--version"], options);
    if (!/(?:^|\s)6\.0\.0(?:\s|$)/.test(result.stdout + result.stderr))
        throw new Error("Barretenberg 6.0.0 is required");
}
export async function checkBBAvailable(bbBin = "bb"): Promise<boolean> {
    try {
        await assertVersion(bbBin, {});
        return true;
    } catch {
        return false;
    }
}
async function verifyInDirectory(
    bundle: ProofBundle,
    directory: string,
    options: NativeOptions
): Promise<void> {
    await assertProofBundle(bundle);
    const keyPath = join(directory, "vk"),
        proofPath = join(directory, "proof"),
        inputPath = join(directory, "public_inputs");
    await writeFile(keyPath, loadVerificationKey(bundle.circuitName, bundle.target));
    await writeFile(proofPath, fromHex(bundle.proofHex));
    await writeFile(inputPath, Buffer.concat(bundle.publicInputs.map((value) => fromHex(value))));
    const result = await run(
        options.bbBin ?? "bb",
        ["verify", "-t", bundle.target, "-k", keyPath, "-p", proofPath, "-i", inputPath],
        options
    );
    if (!/Proof verified successfully/.test(result.stdout + result.stderr))
        throw new Error("Native verification did not confirm proof validity");
}
export async function verifyWithBB(
    bundle: ProofBundle,
    options: NativeOptions = {}
): Promise<boolean> {
    await assertVersion(options.bbBin ?? "bb", options);
    const directory = await mkdtemp(join(tmpdir(), "invisi-verify-"));
    try {
        await verifyInDirectory(bundle, directory, options);
        return true;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
export async function proveWithBB(
    params: NativeOptions & {
        circuitName: CircuitName;
        witness: Uint8Array;
        target?: ProofTarget;
        expectedPublicInputs?: readonly string[];
    }
): Promise<ProofBundle> {
    const bbBin = params.bbBin ?? "bb",
        target = params.target ?? "evm";
    // Loading both assets checks identity and rejects unpublished target combinations.
    const circuit = loadCircuit(params.circuitName),
        key = loadVerificationKey(params.circuitName, target);
    await assertVersion(bbBin, params);
    const directory = await mkdtemp(join(tmpdir(), "invisi-proof-"));
    try {
        const artifactPath = join(directory, "circuit.json"),
            witnessPath = join(directory, "witness.gz"),
            keyPath = join(directory, "vk");
        await writeFile(artifactPath, JSON.stringify(circuit));
        await writeFile(witnessPath, params.witness);
        await writeFile(keyPath, key);
        await run(
            bbBin,
            [
                "prove",
                "-t",
                target,
                "-b",
                artifactPath,
                "-w",
                witnessPath,
                "-k",
                keyPath,
                "-o",
                directory,
                "--output_format",
                "json",
            ],
            params
        );
        const proof = JSON.parse(await readFile(join(directory, "proof.json"), "utf8")) as {
            bb_version: string;
            scheme: string;
            proof: string[];
        };
        const inputs = JSON.parse(
            await readFile(join(directory, "public_inputs.json"), "utf8")
        ) as { public_inputs: string[] };
        if (
            proof.bb_version !== "6.0.0" ||
            proof.scheme !== "ultra_honk" ||
            !Array.isArray(proof.proof) ||
            !Array.isArray(inputs.public_inputs)
        )
            throw new Error("Unsupported native proof output");
        const proofHex =
            `0x${proof.proof.map((value) => fieldHex(value).slice(2)).join("")}` as const;
        const bundle = await makeProofBundle(
            params.circuitName,
            target,
            proofHex,
            inputs.public_inputs.map(fieldHex),
            params.expectedPublicInputs
        );
        await verifyInDirectory(bundle, directory, params);
        return bundle;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
