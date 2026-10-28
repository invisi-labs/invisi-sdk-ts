import { type CircuitName, type CompiledCircuit, type ProofTarget } from "./circuit-types";
import { authenticateCircuit, fromHex, getCircuitKey, sha256 } from "./proof-data";
export { CIRCUIT_NAMES } from "./circuit-types";
export type { CircuitName, CompiledCircuit } from "./circuit-types";
const loaders: Record<CircuitName, () => Promise<{ default: unknown }>> = {
    transact_user_slots14: () => import("../circuits/transact_user_slots14.json"),
    transact_user_slots56: () => import("../circuits/transact_user_slots56.json"),
    transact_user_slots112: () => import("../circuits/transact_user_slots112.json"),
    transact_user_slots168: () => import("../circuits/transact_user_slots168.json"),
    transact_aggregate_14_4: () => import("../circuits/transact_aggregate_14_4.json"),
    transact_aggregate_14_8: () => import("../circuits/transact_aggregate_14_8.json"),
    transact_aggregate_14_12: () => import("../circuits/transact_aggregate_14_12.json"),
    create_credit: () => import("../circuits/create_credit.json"),
    credit_draw_slots1: () => import("../circuits/credit_draw_slots1.json"),
    credit_draw_slots12: () => import("../circuits/credit_draw_slots12.json"),
    credit_draw_slots50: () => import("../circuits/credit_draw_slots50.json"),
    credit_draw_slots120: () => import("../circuits/credit_draw_slots120.json"),
    credit_cancel: () => import("../circuits/credit_cancel.json"),
    credit_top_up: () => import("../circuits/credit_top_up.json"),
    wallet_registration: () => import("../circuits/wallet_registration.json"),
};
export async function loadCircuitBrowser(name: CircuitName): Promise<CompiledCircuit> {
    const loader = loaders[name];
    if (!loader) throw new Error(`Unknown circuit: ${name}`);
    const mod = await loader();
    const circuit = structuredClone(mod.default) as CompiledCircuit;
    await authenticateCircuit(name, circuit);
    return circuit;
}
export async function loadVerificationKeyBrowser(
    name: CircuitName,
    target: ProofTarget = "evm"
): Promise<Uint8Array> {
    const key = getCircuitKey(name, target),
        bytes = fromHex(key.vkHex);
    if ((await sha256(bytes)) !== key.vkSha256)
        throw new Error("Verification key identity mismatch");
    return bytes;
}
