import { normalizeCreditDeliveryState, normalizeCreditPolicy } from "@invisi-labs/core";
import { createCreditPublicInputs } from "../credit/credit-create";
import { check, provingRequest } from "./common";
import type { CreateCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function createCredit(w: WitnessContext, p: CreateCreditWitnessParams) {
    const n = normalizeCreditDeliveryState(p.state).note,
        policy = normalizeCreditPolicy(n),
        words = createCreditPublicInputs(w.protocol.context, p.params, p.deliveries);
    check(
        n.ownerWalletIdentity === p.params.owner &&
            n.revocationShard === p.params.revocationShard &&
            n.revocationSlot === p.params.revocationSlot &&
            n.expiry >= p.params.deadline &&
            (await w.creditLeaf(n)) === p.params.creditCommitment,
        "Credit creation mismatch"
    );
    for (const k of ["lastDay", "dailySpent", "lastMonth", "monthlySpent", "totalSpent"] as const)
        check(policy[k] === 0n, "initial Credit usage must be zero");
    return provingRequest(
        "create_credit",
        {
            ...(await w.authority(
                "create-credit",
                1,
                words,
                p.authorization,
                n.ownerWalletIdentity
            )),
            spender_wallet_identity: BigInt(n.spenderWalletIdentity),
            credit_nonce: n.nonce,
            expiry: n.expiry,
            credit_shared_key: n.creditSharedKey,
            limits: [
                policy.singleLimit,
                policy.dailyLimit,
                policy.monthlyLimit,
                policy.lifetimeLimit,
            ],
        },
        words
    );
}
