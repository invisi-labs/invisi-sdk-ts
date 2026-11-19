import { circuitResourcePin } from "../resources/pin";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { localResourcePath, nodeResources, type NodeResourceOptions } from "../resources/node";
import {
    artifactIdentity,
    authenticateCircuit,
    getCircuitKey,
    getCircuitMetadata,
} from "../proofs/proof-data";
import {
    CIRCUIT_NAMES,
    type CircuitName,
    type CompiledCircuit,
    type ProofTarget,
} from "./circuit-types";
export { CIRCUIT_NAMES };
export type { CircuitName, CompiledCircuit };
export function getCircuitPath(name: CircuitName, options?: NodeResourceOptions): string {
    getCircuitMetadata(name);
    return localResourcePath(`circuits/${name}.json`, options, circuitResourcePin(name));
}
export function getVerificationKeyPath(
    name: CircuitName,
    target: ProofTarget = "evm",
    options?: NodeResourceOptions
): string {
    const key = getCircuitKey(name, target);
    return localResourcePath(`circuits/${key.vk}`, options, circuitResourcePin(name));
}
export function loadCircuit(name: CircuitName, options?: NodeResourceOptions): CompiledCircuit {
    const metadata = getCircuitMetadata(name),
        circuit = JSON.parse(
            readFileSync(getCircuitPath(name, options), "utf8")
        ) as CompiledCircuit;
    if (
        createHash("sha256").update(artifactIdentity(circuit)).digest("hex") !==
        metadata.artifactSha256
    )
        throw new Error("Circuit artifact identity mismatch");
    return circuit;
}
export function loadVerificationKey(
    name: CircuitName,
    target: ProofTarget = "evm",
    options?: NodeResourceOptions
): Uint8Array {
    const key = getCircuitKey(name, target),
        bytes = readFileSync(getVerificationKeyPath(name, target, options));
    if (createHash("sha256").update(bytes).digest("hex") !== key.vkSha256)
        throw new Error("Verification key identity mismatch");
    return bytes;
}
export async function loadCircuitAsync(
    name: CircuitName,
    options?: NodeResourceOptions,
    signal?: AbortSignal
): Promise<CompiledCircuit> {
    getCircuitMetadata(name);
    const bytes = await nodeResources(options, circuitResourcePin(name)).load(
        `circuits/${name}.json`,
        signal
    );
    const circuit = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(bytes)
    ) as CompiledCircuit;
    await authenticateCircuit(name, circuit);
    return circuit;
}
export async function loadVerificationKeyAsync(
    name: CircuitName,
    target: ProofTarget = "evm",
    options?: NodeResourceOptions,
    signal?: AbortSignal
): Promise<Uint8Array> {
    const key = getCircuitKey(name, target),
        bytes = await nodeResources(options, circuitResourcePin(name)).load(
            `circuits/${key.vk}`,
            signal
        );
    if (createHash("sha256").update(bytes).digest("hex") !== key.vkSha256)
        throw new Error("Verification key identity mismatch");
    return bytes;
}
