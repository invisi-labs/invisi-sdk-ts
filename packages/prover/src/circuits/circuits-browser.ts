import { authenticateCircuit, fromHex, getCircuitKey, sha256 } from "../proofs/proof-data";
import { type CircuitName, type CompiledCircuit, type ProofTarget } from "./circuit-types";
export { CIRCUIT_NAMES } from "./circuit-types";
export type { CircuitName, CompiledCircuit } from "./circuit-types";
const loaders: Record<CircuitName, () => Promise<{ default: unknown }>> = {
    transact_user_slots1: () => import("../../circuits/transact_user_slots1.json"),
    transact_user_slots2: () => import("../../circuits/transact_user_slots2.json"),
    transact_user_slots3: () => import("../../circuits/transact_user_slots3.json"),
    transact_user_slots4: () => import("../../circuits/transact_user_slots4.json"),
    transact_user_slots5: () => import("../../circuits/transact_user_slots5.json"),
    transact_user_slots6: () => import("../../circuits/transact_user_slots6.json"),
    transact_user_slots7: () => import("../../circuits/transact_user_slots7.json"),
    transact_user_slots8: () => import("../../circuits/transact_user_slots8.json"),
    transact_user_slots9: () => import("../../circuits/transact_user_slots9.json"),
    transact_user_slots10: () => import("../../circuits/transact_user_slots10.json"),
    transact_user_slots20: () => import("../../circuits/transact_user_slots20.json"),
    transact_user_slots30: () => import("../../circuits/transact_user_slots30.json"),
    transact_user_slots40: () => import("../../circuits/transact_user_slots40.json"),
    transact_user_slots50: () => import("../../circuits/transact_user_slots50.json"),
    transact_user_slots60: () => import("../../circuits/transact_user_slots60.json"),
    transact_user_slots70: () => import("../../circuits/transact_user_slots70.json"),
    transact_user_slots80: () => import("../../circuits/transact_user_slots80.json"),
    transact_user_slots90: () => import("../../circuits/transact_user_slots90.json"),
    transact_user_slots100: () => import("../../circuits/transact_user_slots100.json"),
    transact_user_slots110: () => import("../../circuits/transact_user_slots110.json"),
    transact_user_slots120: () => import("../../circuits/transact_user_slots120.json"),
    transact_user_slots130: () => import("../../circuits/transact_user_slots130.json"),
    transact_user_slots140: () => import("../../circuits/transact_user_slots140.json"),
    transact_user_slots150: () => import("../../circuits/transact_user_slots150.json"),
    transact_user_slots160: () => import("../../circuits/transact_user_slots160.json"),
    transact_user_slots170: () => import("../../circuits/transact_user_slots170.json"),
    transact_user_slots180: () => import("../../circuits/transact_user_slots180.json"),
    transact_user_slots190: () => import("../../circuits/transact_user_slots190.json"),
    transact_aggregate_1_1: () => import("../../circuits/transact_aggregate_1_1.json"),
    transact_aggregate_1_2: () => import("../../circuits/transact_aggregate_1_2.json"),
    transact_aggregate_1_5: () => import("../../circuits/transact_aggregate_1_5.json"),
    transact_aggregate_2_1: () => import("../../circuits/transact_aggregate_2_1.json"),
    transact_aggregate_2_2: () => import("../../circuits/transact_aggregate_2_2.json"),
    transact_aggregate_2_5: () => import("../../circuits/transact_aggregate_2_5.json"),
    transact_aggregate_3_1: () => import("../../circuits/transact_aggregate_3_1.json"),
    transact_aggregate_3_2: () => import("../../circuits/transact_aggregate_3_2.json"),
    transact_aggregate_3_5: () => import("../../circuits/transact_aggregate_3_5.json"),
    transact_aggregate_4_1: () => import("../../circuits/transact_aggregate_4_1.json"),
    transact_aggregate_4_2: () => import("../../circuits/transact_aggregate_4_2.json"),
    transact_aggregate_4_5: () => import("../../circuits/transact_aggregate_4_5.json"),
    transact_aggregate_5_1: () => import("../../circuits/transact_aggregate_5_1.json"),
    transact_aggregate_5_2: () => import("../../circuits/transact_aggregate_5_2.json"),
    transact_aggregate_5_5: () => import("../../circuits/transact_aggregate_5_5.json"),
    transact_aggregate_6_1: () => import("../../circuits/transact_aggregate_6_1.json"),
    transact_aggregate_6_2: () => import("../../circuits/transact_aggregate_6_2.json"),
    transact_aggregate_6_5: () => import("../../circuits/transact_aggregate_6_5.json"),
    transact_aggregate_7_1: () => import("../../circuits/transact_aggregate_7_1.json"),
    transact_aggregate_7_2: () => import("../../circuits/transact_aggregate_7_2.json"),
    transact_aggregate_7_5: () => import("../../circuits/transact_aggregate_7_5.json"),
    transact_aggregate_8_1: () => import("../../circuits/transact_aggregate_8_1.json"),
    transact_aggregate_8_2: () => import("../../circuits/transact_aggregate_8_2.json"),
    transact_aggregate_8_5: () => import("../../circuits/transact_aggregate_8_5.json"),
    transact_aggregate_9_1: () => import("../../circuits/transact_aggregate_9_1.json"),
    transact_aggregate_9_2: () => import("../../circuits/transact_aggregate_9_2.json"),
    transact_aggregate_9_5: () => import("../../circuits/transact_aggregate_9_5.json"),
    transact_aggregate_10_1: () => import("../../circuits/transact_aggregate_10_1.json"),
    transact_aggregate_10_2: () => import("../../circuits/transact_aggregate_10_2.json"),
    transact_aggregate_10_5: () => import("../../circuits/transact_aggregate_10_5.json"),
    transact_aggregate_mixed_1_5_2: () =>
        import("../../circuits/transact_aggregate_mixed_1_5_2.json"),
    transact_aggregate_mixed_1_5_3: () =>
        import("../../circuits/transact_aggregate_mixed_1_5_3.json"),
    transact_aggregate_mixed_1_5_4: () =>
        import("../../circuits/transact_aggregate_mixed_1_5_4.json"),
    transact_aggregate_mixed_1_5_5: () =>
        import("../../circuits/transact_aggregate_mixed_1_5_5.json"),
    create_credit: () => import("../../circuits/create_credit.json"),
    credit_draw_slots1: () => import("../../circuits/credit_draw_slots1.json"),
    credit_draw_slots2: () => import("../../circuits/credit_draw_slots2.json"),
    credit_draw_slots3: () => import("../../circuits/credit_draw_slots3.json"),
    credit_draw_slots4: () => import("../../circuits/credit_draw_slots4.json"),
    credit_draw_slots5: () => import("../../circuits/credit_draw_slots5.json"),
    credit_draw_slots10: () => import("../../circuits/credit_draw_slots10.json"),
    credit_draw_slots20: () => import("../../circuits/credit_draw_slots20.json"),
    credit_draw_slots30: () => import("../../circuits/credit_draw_slots30.json"),
    credit_draw_slots40: () => import("../../circuits/credit_draw_slots40.json"),
    credit_draw_slots50: () => import("../../circuits/credit_draw_slots50.json"),
    credit_draw_slots60: () => import("../../circuits/credit_draw_slots60.json"),
    credit_draw_slots70: () => import("../../circuits/credit_draw_slots70.json"),
    credit_draw_slots80: () => import("../../circuits/credit_draw_slots80.json"),
    credit_update: () => import("../../circuits/credit_update.json"),
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
