export const CIRCUIT_NAMES = [
    "transact_user_slots1",
    "transact_user_slots2",
    "transact_user_slots3",
    "transact_user_slots4",
    "transact_user_slots5",
    "transact_user_slots6",
    "transact_user_slots7",
    "transact_user_slots8",
    "transact_user_slots9",
    "transact_user_slots10",
    "transact_user_slots20",
    "transact_user_slots30",
    "transact_user_slots40",
    "transact_user_slots50",
    "transact_user_slots60",
    "transact_user_slots70",
    "transact_user_slots80",
    "transact_user_slots90",
    "transact_user_slots100",
    "transact_user_slots110",
    "transact_user_slots120",
    "transact_user_slots130",
    "transact_user_slots140",
    "transact_user_slots150",
    "transact_user_slots160",
    "transact_user_slots170",
    "transact_user_slots180",
    "transact_user_slots190",
    "transact_aggregate_1_1",
    "transact_aggregate_1_2",
    "transact_aggregate_1_5",
    "transact_aggregate_2_1",
    "transact_aggregate_2_2",
    "transact_aggregate_2_5",
    "transact_aggregate_3_1",
    "transact_aggregate_3_2",
    "transact_aggregate_3_5",
    "transact_aggregate_4_1",
    "transact_aggregate_4_2",
    "transact_aggregate_4_5",
    "transact_aggregate_5_1",
    "transact_aggregate_5_2",
    "transact_aggregate_5_5",
    "transact_aggregate_6_1",
    "transact_aggregate_6_2",
    "transact_aggregate_6_5",
    "transact_aggregate_7_1",
    "transact_aggregate_7_2",
    "transact_aggregate_7_5",
    "transact_aggregate_8_1",
    "transact_aggregate_8_2",
    "transact_aggregate_8_5",
    "transact_aggregate_9_1",
    "transact_aggregate_9_2",
    "transact_aggregate_9_5",
    "transact_aggregate_10_1",
    "transact_aggregate_10_2",
    "transact_aggregate_10_5",
    "transact_aggregate_mixed_1_5_2",
    "transact_aggregate_mixed_1_5_3",
    "transact_aggregate_mixed_1_5_4",
    "transact_aggregate_mixed_1_5_5",
    "create_credit",
    "create_credit_initial_payment",
    "credit_draw_slots1",
    "credit_draw_slots2",
    "credit_draw_slots3",
    "credit_draw_slots4",
    "credit_draw_slots5",
    "credit_draw_slots10",
    "credit_draw_slots20",
    "credit_draw_slots30",
    "credit_draw_slots40",
    "credit_draw_slots50",
    "credit_draw_slots60",
    "credit_draw_slots70",
    "credit_draw_slots80",
    "credit_update",
] as const;
export type CircuitName = (typeof CIRCUIT_NAMES)[number];
export type ProofTarget = "evm" | "noir-recursive";
export type Hex = `0x${string}`;
export interface CompiledCircuit {
    noir_version: string;
    hash?: number | string;
    artifact_version?: number;
    abi: {
        parameters: Array<{ name: string; type: Record<string, unknown>; visibility: string }>;
        return_type: unknown;
    };
    bytecode: string;
    debug_symbols?: unknown;
    file_map?: Record<string, unknown>;
    expression_width?: number;
}
export interface CircuitKey {
    target: ProofTarget;
    vkSha256: string;
    vk: string;
    innerVkCommitment?: Hex;
    /** Authenticated key hash used to reconstruct recursive Noir VK inputs. */
    vkHash?: Hex;
}
export interface CircuitMetadata {
    name: CircuitName;
    artifactSha256: string;
    publicInputCount: number;
    capacity?: number;
    count?: number;
    innerVkCommitment?: Hex;
    innerVkCommitments?: Hex[];
    keys: Partial<Record<ProofTarget, CircuitKey>>;
}
export interface ProofBundle {
    formatVersion: 1;
    circuitName: CircuitName;
    target: ProofTarget;
    bbVersion: "6.0.0";
    artifactSha256: string;
    vkSha256: string;
    proofHex: Hex;
    proofSha256: string;
    publicInputs: Hex[];
}
