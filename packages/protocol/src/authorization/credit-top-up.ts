import { computeCreditNullifier, normalizeCreditDeliveryState } from "@invisi-labs/core";
import { type ProvingRequest } from "@invisi-labs/prover";
import { topUpCreditPublicInputs } from "../credit/credit-lifecycle";
import { check, provingRequest } from "./common";
import { creation } from "./credit-creation";
import type { TopUpCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function topUpCredit(
    witness: WitnessContext,
    p: TopUpCreditWitnessParams
): Promise<ProvingRequest> {
    const c = witness.protocol.context,
        previous = normalizeCreditDeliveryState(p.previous.state),
        next = normalizeCreditDeliveryState(p.state),
        old = previous.note,
        note = next.note,
        leaf = await witness.creditLeaf(old);
    for (const field of [
        "spenderWalletIdentity",
        "ownerWalletIdentity",
        "spenderPayout",
        "ownerPayout",
        "creditSharedKey",
        "lastDay",
        "dailySpent",
        "lastMonth",
        "monthlySpent",
    ] as const)
        check(old[field] === note[field], "Credit role or payout changed");
    check(
        JSON.stringify(previous.ownerReceivingKeys) === JSON.stringify(next.ownerReceivingKeys) &&
            JSON.stringify(previous.spenderReceivingKeys) ===
                JSON.stringify(next.spenderReceivingKeys),
        "Credit receiving snapshots changed"
    );
    check(
        old.amount < note.amount &&
            old.expiry <= note.expiry &&
            old.expiry === p.params.previousExpiry &&
            (c.now === undefined || old.expiry > c.now),
        "invalid Credit top-up"
    );
    check(
        (await computeCreditNullifier(c.chainId, old.creditSharedKey, leaf)) ===
            p.params.creditNullifier,
        "previous Credit nullifier mismatch"
    );
    await witness.membership(leaf, p.previous, [p.params.creditSource]);
    const words = topUpCreditPublicInputs(c, p.params, p.deliveries, p.funding),
        base = await creation(witness, { ...p, params: p.params.creation }, "top-up-credit", words);
    return provingRequest(
        "credit_top_up",
        {
            ...base,
            previous_single_limit: old.singleLimit!,
            previous_daily_limit: old.dailyLimit!,
            previous_monthly_limit: old.monthlyLimit!,
            previous_credit_amount: old.amount,
            previous_credit_nonce: old.nonce,
            previous_credit_leaf_index: BigInt(p.previous.leafIndex),
            previous_credit_merkle_path: [...p.previous.path],
        },
        words
    );
}
