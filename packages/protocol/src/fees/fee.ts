import { getAddress } from "ethers";
import type { Address } from "../contracts/index";
import { uint, ZERO_ADDRESS } from "../validation";
/** Canonical optional public fee. Omitting both fields explicitly selects zero fee. */
export function normalizeFee(p: { feeRecipient?: Address; feeAmount?: bigint }) {
    const feeRecipient = getAddress(p.feeRecipient ?? ZERO_ADDRESS) as Address;
    const feeAmount = uint(p.feeAmount ?? 0n, 128, "feeAmount");
    if ((BigInt(feeRecipient) === 0n) !== (feeAmount === 0n))
        throw new Error("invalid fee context");
    return { feeRecipient, feeAmount };
}
