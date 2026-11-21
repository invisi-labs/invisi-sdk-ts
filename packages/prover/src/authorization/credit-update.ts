import {
    normalizeCreditPolicy,
    normalizeCreditUsage,
    deriveCreditUpdate,
} from "@invisi-labs/primitives";
import { updateCreditPublicInputs } from "@invisi-labs/protocol";
import { check, provingRequest } from "./common";
import type { UpdateCreditWitnessParams } from "./types";
import { WitnessContext } from "./WitnessContext";
export async function updateCredit(w: WitnessContext, p: UpdateCreditWitnessParams) {
    const n = p.input.state.note,
        next = p.state.note,
        old = normalizeCreditPolicy(n),
        fresh = normalizeCreditPolicy(next),
        derived = await deriveCreditUpdate(n, p.changes, p.params.deadline),
        words = updateCreditPublicInputs(w.protocol.context, p.params, p.deliveries);
    check(
        n.ownerWalletIdentity === p.params.owner &&
            n.grantId === p.params.grantId &&
            derived.nullifier === p.params.nullifier &&
            derived.stateCommitment === p.params.creditCommitment &&
            (await w.creditLeaf(next)) === p.params.creditCommitment,
        "Credit update mismatch"
    );
    await w.membership(await w.creditLeaf(n), p.input, [p.params.source]);
    return provingRequest(
        "credit_update",
        {
            ...(await w.authority(
                "update-credit",
                1,
                words,
                p.authorization,
                n.ownerWalletIdentity
            )),
            spender_wallet_identity: BigInt(n.spenderWalletIdentity),
            input_nonce: n.nonce,
            old_expiry: n.expiry,
            new_expiry: next.expiry,
            credit_shared_key: n.creditSharedKey,
            old_limits: [old.singleLimit, old.dailyLimit, old.monthlyLimit],
            new_limits: [fresh.singleLimit, fresh.dailyLimit, fresh.monthlyLimit],
            old_available_credit: n.availableCredit,
            old_unlimited: BigInt(n.unlimited),
            new_unlimited: BigInt(next.unlimited),
            increase_available_credit: p.changes.increaseAvailableCredit ?? 0n,
            decrease_available_credit: p.changes.decreaseAvailableCredit ?? 0n,
            usage: (() => {
                const u = normalizeCreditUsage(n);
                return [u.lastDay, u.dailySpent, u.lastMonth, u.monthlySpent, u.totalSpent];
            })(),
            leaf_index: BigInt(p.input.leafIndex),
            merkle_path: [...p.input.path],
        },
        words
    );
}
