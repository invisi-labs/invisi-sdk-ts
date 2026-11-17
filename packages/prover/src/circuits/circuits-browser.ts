import { authenticateCircuit, getCircuitKey, sha256 } from "../proofs/proof-data";
import { browserResources } from "../resources/browser";
import type { ResourceOptions } from "../resources/loader";
import { type CircuitName, type CompiledCircuit, type ProofTarget } from "./circuit-types";
export { CIRCUIT_NAMES } from "./circuit-types";
export type { CircuitName, CompiledCircuit };
export async function loadCircuitBrowser(
    name: CircuitName,
    options?: ResourceOptions,
    signal?: AbortSignal
): Promise<CompiledCircuit> {
    const bytes = await browserResources(options).load(`circuits/${name}.json`, signal);
    const circuit = JSON.parse(
        new TextDecoder("utf8", { fatal: true }).decode(bytes)
    ) as CompiledCircuit;
    await authenticateCircuit(name, circuit);
    return circuit;
}
export async function loadVerificationKeyBrowser(
    name: CircuitName,
    target: ProofTarget = "evm",
    options?: ResourceOptions,
    signal?: AbortSignal
): Promise<Uint8Array> {
    const key = getCircuitKey(name, target),
        bytes = await browserResources(options).load(`circuits/${key.vk}`, signal);
    if ((await sha256(bytes)) !== key.vkSha256)
        throw new Error("Verification key identity mismatch");
    return bytes;
}
