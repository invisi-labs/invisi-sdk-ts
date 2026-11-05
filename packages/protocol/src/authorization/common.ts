import {
    normalizeCreditPolicy,
    type CreditNote,
    type WalletAuthorizationWitness,
} from "@invisi-labs/core";
import {
    LocalWitness,
    type CircuitName,
    type ProofStatement,
    type ProofTarget,
    type ProvingRequest,
} from "@invisi-labs/prover";
import type { Hex } from "../contracts/index";
import { FIELD_MODULUS } from "../validation";
import layouts from "../witness-layouts.json";

export const pad = <T>(values: readonly T[], count: number, zero: () => T): T[] => {
    if (values.length > count) throw new Error("witness capacity exceeded");
    return [...values, ...Array.from({ length: count - values.length }, zero)];
};

export const policyWitness = (note: CreditNote, usage = true) => {
    const p = normalizeCreditPolicy(note);
    return {
        single_limit: p.singleLimit,
        daily_limit: p.dailyLimit,
        monthly_limit: p.monthlyLimit,
        ...(usage
            ? {
                  last_day: p.lastDay,
                  daily_spent: p.dailySpent,
                  last_month: p.lastMonth,
                  monthly_spent: p.monthlySpent,
              }
            : {}),
    };
};

export const zeros = () => Array<bigint>(16).fill(0n);

export const zeroAuthority = (): WalletAuthorizationWitness => ({
    public_key_x: Array<number>(32).fill(0),
    public_key_y: Array<number>(32).fill(0),
    signature: Array<number>(64).fill(0),
});

export function check(ok: boolean, message: string): asserts ok {
    if (!ok) throw new Error(message);
}

export function provingRequest(
    circuitName: CircuitName,
    privateInputs: Record<string, unknown>,
    expectedPublicInputs: readonly Hex[],
    target: ProofTarget = "evm"
): ProvingRequest {
    const schema = layouts[circuitName],
        key = schema.keys[target as keyof typeof schema.keys];
    check(typeof key === "string", "unpublished proof target");
    check(
        expectedPublicInputs.length === schema.publicInputCount,
        "public input order/width mismatch"
    );
    check(
        Object.keys(privateInputs).length === schema.private.length &&
            schema.private.every((name) => Object.hasOwn(privateInputs, name)),
        "private witness schema mismatch"
    );
    let offset = 0;
    const publicInputs: Record<string, unknown> = {};
    for (const entry of schema.public) {
        const values = expectedPublicInputs.slice(offset, offset + entry.count).map((value) => {
            const n = BigInt(value);
            check(n >= 0n && n < FIELD_MODULUS, "noncanonical public input");
            return n;
        });
        publicInputs[entry.name] = entry.array ? values : values[0];
        offset += entry.count;
    }
    check(offset === expectedPublicInputs.length, "public input layout mismatch");
    return {
        circuitName,
        target,
        artifactSha256: schema.artifactSha256,
        vkSha256: key,
        expectedPublicInputs: [...expectedPublicInputs],
        witness: new LocalWitness({ ...privateInputs, ...publicInputs }),
    };
}
export function witnessStatement(
    circuitName: CircuitName,
    expectedPublicInputs: readonly Hex[],
    target: ProofTarget = "evm"
): ProofStatement {
    const schema = layouts[circuitName],
        key = schema.keys[target as keyof typeof schema.keys];
    check(
        typeof key === "string" && expectedPublicInputs.length === schema.publicInputCount,
        "unpublished target or statement width mismatch"
    );
    return {
        circuitName,
        target,
        artifactSha256: schema.artifactSha256,
        vkSha256: key,
        expectedPublicInputs: [...expectedPublicInputs],
    };
}
