import { getAddress } from "ethers";
import type { TransferPreparation } from "./session/operation-types";
export type TransferFee = NonNullable<TransferPreparation["fee"]>;
export interface FeeEstimateContext {
    gasUnits: bigint;
    capacity: number | undefined;
    inputs: number;
    outputs: number;
    attempt: number;
}
export type TransferFeeEstimator = (
    context: FeeEstimateContext
) => TransferFee | Promise<TransferFee>;
export interface FeePreparationOptions {
    /** User-approved upper bound, in the operation token's base units. */
    maxFeeAmount: bigint;
    /** Total preparations, including the first. Defaults to four, at most sixteen. */
    maxAttempts?: number;
    initialFee?: TransferFee;
}
interface EstimablePreparation {
    estimateGas(): { gasUnits: bigint };
    preview(): { capacity: number | undefined; inputs: number; outputs: readonly unknown[] };
}
/** Iterate side-effect-free local drafts before authorization/proof. The estimator sees only shape. */
export async function prepareWithEstimatedFee<T extends EstimablePreparation>(
    prepare: (fee: TransferFee | undefined) => Promise<T>,
    estimate: TransferFeeEstimator,
    options: FeePreparationOptions
): Promise<T> {
    const maxAttempts = options.maxAttempts ?? 4;
    const maxFeeAmount = options.maxFeeAmount;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 16)
        throw new Error("fee preparation maxAttempts must be 1..16");
    if (typeof maxFeeAmount !== "bigint" || maxFeeAmount <= 0n || maxFeeAmount >= 1n << 128n)
        throw new Error("fee limit must be a positive uint128");
    const validate = (fee: TransferFee): TransferFee => {
        const recipient = getAddress(fee.recipient) as TransferFee["recipient"];
        if (
            BigInt(recipient) === 0n ||
            typeof fee.amount !== "bigint" ||
            fee.amount <= 0n ||
            fee.amount >= 1n << 128n
        )
            throw new Error(
                "estimated fee requires a nonzero recipient and positive uint128 amount"
            );
        if (fee.amount > maxFeeAmount) throw new Error("estimated fee exceeds user limit");
        return { recipient, amount: fee.amount };
    };
    let fee = options.initialFee ? validate(options.initialFee) : undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const prepared = await prepare(fee ? { ...fee } : undefined);
        const preview = prepared.preview();
        const next = validate(
            await estimate({
                ...prepared.estimateGas(),
                capacity: preview.capacity,
                inputs: preview.inputs,
                outputs: preview.outputs.length,
                attempt,
            })
        );
        if (fee && fee.amount === next.amount && fee.recipient === next.recipient) return prepared;
        fee = next;
    }
    throw new Error("fee estimate did not stabilize within the preparation limit");
}
