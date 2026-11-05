import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { artifactIdentity, getCircuitKey, getCircuitMetadata } from "../proofs/proof-data";
import {
    CIRCUIT_NAMES,
    type CircuitName,
    type CompiledCircuit,
    type ProofTarget,
} from "./circuit-types";
export { CIRCUIT_NAMES };
export type { CircuitName, CompiledCircuit };
const moduleDirectory =
    typeof __dirname === "string" ? __dirname : dirname(fileURLToPath(import.meta.url));
// Bundled entries live in dist; source tests run one directory deeper.
const packagedCircuits = join(moduleDirectory, "..", "circuits");
const circuitsDir = existsSync(join(packagedCircuits, "manifest.json"))
    ? packagedCircuits
    : join(moduleDirectory, "..", "..", "circuits");
export function loadCircuit(name: CircuitName): CompiledCircuit {
    const metadata = getCircuitMetadata(name);
    const circuit = JSON.parse(readFileSync(getCircuitPath(name), "utf-8")) as CompiledCircuit;
    if (
        createHash("sha256").update(artifactIdentity(circuit)).digest("hex") !==
        metadata.artifactSha256
    )
        throw new Error(`Circuit artifact identity mismatch: ${name}`);
    return circuit;
}
export function getCircuitPath(name: CircuitName): string {
    getCircuitMetadata(name);
    return join(circuitsDir, `${name}.json`);
}
export function getVerificationKeyPath(name: CircuitName, target: ProofTarget = "evm"): string {
    return join(circuitsDir, getCircuitKey(name, target).vk);
}
export function loadVerificationKey(name: CircuitName, target: ProofTarget = "evm"): Uint8Array {
    const key = getCircuitKey(name, target),
        bytes = readFileSync(getVerificationKeyPath(name, target));
    if (createHash("sha256").update(bytes).digest("hex") !== key.vkSha256)
        throw new Error("Verification key identity mismatch");
    return bytes;
}
