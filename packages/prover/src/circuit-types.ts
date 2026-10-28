export const CIRCUIT_NAMES = [
    "transact_user_slots14",
    "transact_user_slots56",
    "transact_user_slots112",
    "transact_user_slots168",
    "transact_aggregate_14_4",
    "transact_aggregate_14_8",
    "transact_aggregate_14_12",
    "create_credit",
    "credit_draw_slots1",
    "credit_draw_slots12",
    "credit_draw_slots50",
    "credit_draw_slots120",
    "credit_cancel",
    "credit_top_up",
    "wallet_registration",
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
    vkHex: Hex;
    innerVkCommitment?: Hex;
    /** Authenticated recursive Noir VK fields and key hash. */ vkFields?: Hex[];
    vkHash?: Hex;
}
export interface CircuitMetadata {
    name: CircuitName;
    artifactSha256: string;
    publicInputCount: number;
    capacity?: number;
    count?: number;
    innerVkCommitment?: Hex;
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
